const BOT_USER_AGENT =
  /(bot|crawler|spider|slurp|bingpreview|facebookexternalhit|twitterbot|linkedinbot|discordbot|whatsapp|telegrambot|pinterest|headlesschrome|lighthouse|pagespeed|uptimerobot|pingdom|curl|wget|python-requests|go-http-client|axios|ahrefs|semrush|mj12bot|bytespider)/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /*
     * Protected endpoint for manually sending a test report.
     */
    if (url.pathname === "/__visitor-report-test") {
      return handleTestReport(request, env);
    }

    /*
     * Continue the request to your existing AWS S3 website.
     */
    const response = await fetch(request);

    /*
     * Record the visit in the background without delaying
     * the website response.
     */
    if (shouldTrackVisit(request, response)) {
      ctx.waitUntil(
        recordVisit(request, env).catch((error) => {
          console.error("Visitor logging failed:", error);
        })
      );
    }

    return response;
  },

  /*
   * Called by the Cloudflare Cron Trigger.
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      sendPendingReport(env).catch((error) => {
        console.error("Scheduled report failed:", error);
      })
    );
  },
};

/*
 * Sends a report immediately when you use the protected
 * test URL through PowerShell.
 */
async function handleTestReport(request, env) {
  if (request.method !== "POST") {
    return new Response("Use a POST request.", {
      status: 405,
      headers: {
        Allow: "POST",
      },
    });
  }

  const providedToken =
    request.headers.get("x-admin-token") || "";

  if (
    !env.ADMIN_TOKEN ||
    providedToken !== env.ADMIN_TOKEN
  ) {
    return new Response("Unauthorized.", {
      status: 401,
    });
  }

  try {
    const result = await sendPendingReport(env);

    if (!result.sent) {
      return new Response(
        "No stored visits were available to send.",
        {
          status: 200,
        }
      );
    }

    return new Response(
      `Report sent. ${result.visitors} unique visitor(s), ` +
        `${result.pageViews} page view(s).`,
      {
        status: 200,
      }
    );
  } catch (error) {
    console.error("Manual report failed:", error);

    return new Response(
      `Report failed: ${error.message}`,
      {
        status: 500,
      }
    );
  }
}

/*
 * Determines whether a request looks like a real HTML
 * page visit rather than an image, stylesheet, bot, or file.
 */
function shouldTrackVisit(request, response) {
  if (request.method !== "GET") {
    return false;
  }

  if (!response.ok) {
    return false;
  }

  /*
   * Only record HTML pages.
   *
   * This excludes:
   * - CSS
   * - JavaScript
   * - Images
   * - PDFs
   * - Fonts
   * - Other files
   */
  const contentType =
    response.headers.get("content-type") || "";

  if (
    !contentType
      .toLowerCase()
      .includes("text/html")
  ) {
    return false;
  }

  /*
   * A normal webpage navigation usually has:
   *
   * sec-fetch-dest: document
   */
  const destination =
    request.headers.get("sec-fetch-dest");

  if (
    destination &&
    destination !== "document"
  ) {
    return false;
  }

  /*
   * Ignore browser prefetching.
   */
  const purpose =
    request.headers.get("purpose") ||
    request.headers.get("sec-purpose") ||
    "";

  if (
    purpose
      .toLowerCase()
      .includes("prefetch")
  ) {
    return false;
  }

  const userAgent =
    request.headers.get("user-agent") || "";

  /*
   * Ignore empty user agents and common bots.
   */
  if (
    !userAgent ||
    BOT_USER_AGENT.test(userAgent)
  ) {
    return false;
  }

  /*
   * These bot-management fields are used only when
   * Cloudflare makes them available for your plan.
   */
  const botManagement =
    request.cf?.botManagement;

  if (
    botManagement?.verifiedBot === true
  ) {
    return false;
  }

  if (
    typeof botManagement?.score === "number" &&
    botManagement.score < 30
  ) {
    return false;
  }

  return true;
}

/*
 * Stores one visitor record per IP address per calendar day.
 */
async function recordVisit(request, env) {
  if (!env.VISITOR_LOGS) {
    throw new Error(
      "The VISITOR_LOGS KV binding is missing."
    );
  }

  const forwardedIp =
    request.headers
      .get("X-Forwarded-For")
      ?.split(",")[0]
      ?.trim();

  const ip =
    request.headers.get("CF-Connecting-IP") ||
    forwardedIp ||
    "Unknown";

  /*
   * Ignore IP addresses added to the optional
   * EXCLUDED_IPS variable.
   */
  if (
    isExcludedIp(
      ip,
      env.EXCLUDED_IPS
    )
  ) {
    return;
  }

  const date = getChicagoDate();

  /*
   * The IP is hashed for the KV key name.
   *
   * The complete IP remains inside the private record
   * so it can appear in your report.
   */
  const visitorHash =
    await sha256(`${date}:${ip}`);

  const key =
    `visit:${date}:${visitorHash}`;

  const url = new URL(request.url);
  const now = new Date().toISOString();
  const cf = request.cf || {};

  let referrer =
    "Direct or unavailable";

  const referrerHeader =
    request.headers.get("referer");

  if (referrerHeader) {
    try {
      referrer =
        new URL(referrerHeader).hostname;
    } catch {
      referrer = "Unavailable";
    }
  }

  let visit =
    await env.VISITOR_LOGS.get(
      key,
      {
        type: "json",
      }
    );

  /*
   * Create the visitor record when this IP has not
   * already been recorded today.
   */
  if (!visit) {
    visit = {
      ip,
      date,
      firstSeen: now,
      lastSeen: now,
      pageViews: 0,
      pages: {},
      city: cf.city || "Unknown",
      region: cf.region || "Unknown",
      regionCode:
        cf.regionCode || "",
      postalCode:
        cf.postalCode || "",
      country:
        cf.country || "Unknown",
      timezone:
        cf.timezone || "",
      internetProvider:
        cf.asOrganization || "Unknown",
      referrer,
      userAgent:
        request.headers.get("user-agent") ||
        "Unknown",
    };
  }

  visit.lastSeen = now;

  visit.pageViews =
    Number(visit.pageViews || 0) + 1;

  visit.pages[url.pathname] =
    Number(
      visit.pages[url.pathname] || 0
    ) + 1;

  /*
   * Unsent records automatically expire after
   * eight days.
   */
  await env.VISITOR_LOGS.put(
    key,
    JSON.stringify(visit),
    {
      expirationTtl:
        8 * 24 * 60 * 60,
    }
  );
}

/*
 * Checks whether an IP appears in the optional
 * EXCLUDED_IPS variable.
 *
 * Multiple IP addresses should be separated by commas.
 */
function isExcludedIp(
  ip,
  excludedIpsValue
) {
  if (!excludedIpsValue) {
    return false;
  }

  const excludedIps =
    excludedIpsValue
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

  return excludedIps.includes(ip);
}

/*
 * Collects every unsent visitor record and sends
 * one report.
 *
 * When no visits exist, no email is sent.
 */
async function sendPendingReport(env) {
  validateEnvironment(env);

  const keys =
    await listKeysWithPrefix(
      env.VISITOR_LOGS,
      "visit:"
    );

  /*
   * No stored records means no email.
   */
  if (keys.length === 0) {
    return {
      sent: false,
      visitors: 0,
      pageViews: 0,
    };
  }

  const rawVisits = [];

  for (const key of keys) {
    const visit =
      await env.VISITOR_LOGS.get(
        key,
        {
          type: "json",
        }
      );

    if (visit) {
      rawVisits.push(visit);
    }
  }

  if (rawVisits.length === 0) {
    return {
      sent: false,
      visitors: 0,
      pageViews: 0,
    };
  }

  /*
   * Merge records for the same IP address.
   *
   * This prevents one visitor from appearing twice when
   * stored records cross midnight.
   */
  const visits =
    mergeVisitsByIp(rawVisits);

  const totalPageViews =
    visits.reduce(
      (total, visit) =>
        total +
        Number(visit.pageViews || 0),
      0
    );

  const reportTime =
    formatCentralTime(
      new Date().toISOString()
    );

  const textBody =
    createTextReport(
      reportTime,
      visits,
      totalPageViews
    );

  const htmlBody =
    createHtmlReport(
      reportTime,
      visits,
      totalPageViews
    );

  /*
   * Ask Resend to deliver the report.
   */
  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${env.RESEND_API_KEY}`,

        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        from:
          env.REPORT_FROM_EMAIL ||
          "Website Alerts <onboarding@resend.dev>",

        to: [
          env.REPORT_TO_EMAIL,
        ],

        subject:
          `Website report: ` +
          `${visits.length} unique visitor` +
          `${visits.length === 1 ? "" : "s"}, ` +
          `${totalPageViews} page view` +
          `${totalPageViews === 1 ? "" : "s"}`,

        text: textBody,
        html: htmlBody,
      }),
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Resend returned ` +
        `${response.status}: ` +
        `${errorText.slice(0, 500)}`
    );
  }

  /*
   * Delete records only after Resend accepts
   * the email.
   */
  await Promise.all(
    keys.map((key) =>
      env.VISITOR_LOGS.delete(key)
    )
  );

  return {
    sent: true,
    visitors: visits.length,
    pageViews: totalPageViews,
  };
}

/*
 * Combines multiple records belonging to the same IP.
 */
function mergeVisitsByIp(rawVisits) {
  const merged = new Map();

  for (const visit of rawVisits) {
    const mapKey =
      visit.ip || "Unknown";

    const existing =
      merged.get(mapKey);

    if (!existing) {
      merged.set(mapKey, {
        ...visit,

        pages: {
          ...(visit.pages || {}),
        },

        pageViews:
          Number(
            visit.pageViews || 0
          ),
      });

      continue;
    }

    if (
      new Date(visit.firstSeen) <
      new Date(existing.firstSeen)
    ) {
      existing.firstSeen =
        visit.firstSeen;
    }

    if (
      new Date(visit.lastSeen) >
      new Date(existing.lastSeen)
    ) {
      existing.lastSeen =
        visit.lastSeen;
    }

    existing.pageViews +=
      Number(
        visit.pageViews || 0
      );

    for (
      const [page, count] of
      Object.entries(
        visit.pages || {}
      )
    ) {
      existing.pages[page] =
        Number(
          existing.pages[page] || 0
        ) +
        Number(count);
    }
  }

  return Array.from(
    merged.values()
  ).sort(
    (a, b) =>
      new Date(a.firstSeen).getTime() -
      new Date(b.firstSeen).getTime()
  );
}

/*
 * Confirms that all required Cloudflare bindings
 * and variables exist.
 */
function validateEnvironment(env) {
  const missing = [];

  if (!env.VISITOR_LOGS) {
    missing.push("VISITOR_LOGS");
  }

  if (!env.RESEND_API_KEY) {
    missing.push("RESEND_API_KEY");
  }

  if (!env.REPORT_TO_EMAIL) {
    missing.push("REPORT_TO_EMAIL");
  }

  if (missing.length > 0) {
    throw new Error(
      "Missing required Worker binding " +
        `or variable: ${missing.join(", ")}`
    );
  }
}

/*
 * Retrieves every KV key beginning with the
 * supplied prefix.
 */
async function listKeysWithPrefix(
  namespace,
  prefix
) {
  const keys = [];
  let cursor;

  do {
    const options = {
      prefix,
      limit: 1000,
    };

    if (cursor) {
      options.cursor = cursor;
    }

    const result =
      await namespace.list(options);

    for (const key of result.keys) {
      keys.push(key.name);
    }

    if (result.list_complete) {
      break;
    }

    cursor = result.cursor;
  } while (cursor);

  return keys;
}

/*
 * Creates the plain-text version of the email.
 */
function createTextReport(
  reportTime,
  visits,
  totalPageViews
) {
  const lines = [
    "Website visitor report",
    "",
    `Report sent: ${reportTime}`,
    `Unique visitors: ${visits.length}`,
    `Recorded page views: ${totalPageViews}`,
    "",
  ];

  visits.forEach(
    (visit, index) => {
      const pages =
        Object.entries(
          visit.pages || {}
        )
          .map(
            ([page, count]) =>
              `${page} (${count})`
          )
          .join(", ");

      lines.push(
        `Visitor ${index + 1}`,
        `IP: ${visit.ip} (${getIpType(visit.ip)})`,
        `Location: ${formatLocation(visit)}`,
        `Internet provider: ${visit.internetProvider}`,
        `First visit: ${formatCentralTime(visit.firstSeen)}`,
        `Last activity: ${formatCentralTime(visit.lastSeen)}`,
        `Recorded page views: ${visit.pageViews}`,
        `Pages: ${pages || "Unavailable"}`,
        `Referrer: ${visit.referrer}`,
        `Browser/device: ${visit.userAgent}`,
        ""
      );
    }
  );

  return lines.join("\n");
}

/*
 * Creates the formatted HTML version of the email.
 */
function createHtmlReport(
  reportTime,
  visits,
  totalPageViews
) {
  const rows =
    visits
      .map((visit) => {
        const pages =
          Object.entries(
            visit.pages || {}
          )
            .map(
              ([page, count]) =>
                `${escapeHtml(page)} ` +
                `<strong>(${escapeHtml(count)})</strong>`
            )
            .join("<br>");

        return `
          <tr>
            <td style="padding:10px;border:1px solid #ddd;vertical-align:top;">
              <strong>${escapeHtml(visit.ip)}</strong>
              <br>
              <small>${escapeHtml(getIpType(visit.ip))}</small>
            </td>

            <td style="padding:10px;border:1px solid #ddd;vertical-align:top;">
              ${escapeHtml(formatLocation(visit))}
              <br>
              <small>
                ${escapeHtml(visit.internetProvider)}
              </small>
            </td>

            <td style="padding:10px;border:1px solid #ddd;vertical-align:top;">
              ${escapeHtml(formatCentralTime(visit.firstSeen))}
              <br>
              <small>
                Last:
                ${escapeHtml(formatCentralTime(visit.lastSeen))}
              </small>
            </td>

            <td style="padding:10px;border:1px solid #ddd;vertical-align:top;">
              ${pages || "Unavailable"}
            </td>

            <td style="padding:10px;border:1px solid #ddd;vertical-align:top;">
              ${escapeHtml(visit.referrer)}
            </td>
          </tr>
        `;
      })
      .join("");

  return `
    <!DOCTYPE html>
    <html lang="en">
      <body style="font-family:Arial,sans-serif;color:#222;">
        <h2>Website visitor report</h2>

        <p>
          <strong>Report sent:</strong>
          ${escapeHtml(reportTime)}
          <br>

          <strong>Unique visitors:</strong>
          ${visits.length}
          <br>

          <strong>Recorded page views:</strong>
          ${totalPageViews}
        </p>

        <table style="border-collapse:collapse;width:100%;font-size:14px;">
          <thead>
            <tr>
              <th style="padding:10px;border:1px solid #ddd;text-align:left;">
                IP address
              </th>

              <th style="padding:10px;border:1px solid #ddd;text-align:left;">
                Approximate location
              </th>

              <th style="padding:10px;border:1px solid #ddd;text-align:left;">
                Time
              </th>

              <th style="padding:10px;border:1px solid #ddd;text-align:left;">
                Pages
              </th>

              <th style="padding:10px;border:1px solid #ddd;text-align:left;">
                Referrer
              </th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>
        </table>

        <p style="font-size:12px;color:#666;">
          Locations are approximate and may be affected by VPNs,
          cellular networks, shared connections, and
          internet-provider routing.
        </p>
      </body>
    </html>
  `;
}

/*
 * Formats the approximate location.
 */
function formatLocation(visit) {
  const state =
    visit.regionCode
      ? `${visit.region} (${visit.regionCode})`
      : visit.region;

  const values = [
    visit.city,
    state,
    visit.postalCode,
    visit.country,
  ].filter(
    (value) =>
      value &&
      value !== "Unknown"
  );

  return values.length > 0
    ? values.join(", ")
    : "Unknown";
}

/*
 * Converts timestamps to Central Time.
 */
function formatCentralTime(isoDate) {
  if (!isoDate) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone:
        "America/Chicago",

      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }
  ).format(
    new Date(isoDate)
  );
}

/*
 * Returns the current calendar date in Central Time.
 */
function getChicagoDate(
  date = new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/Chicago",

        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(date);

  const values =
    Object.fromEntries(
      parts.map((part) => [
        part.type,
        part.value,
      ])
    );

  return (
    `${values.year}-` +
    `${values.month}-` +
    `${values.day}`
  );
}

/*
 * Creates a SHA-256 hash for the private KV key name.
 */
async function sha256(value) {
  const encoded =
    new TextEncoder()
      .encode(value);

  const hashBuffer =
    await crypto.subtle.digest(
      "SHA-256",
      encoded
    );

  return Array.from(
    new Uint8Array(hashBuffer)
  )
    .map((byte) =>
      byte
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
}

/*
 * Prevents visitor data from being treated as HTML
 * inside the report.
 */
function getIpType(ip) {
  if (!ip || ip === "Unknown") {
    return "Unknown";
  }

  return ip.includes(":") ? "IPv6" : "IPv4";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
