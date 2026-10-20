import { AttributionNotice } from "@/features/quotes/attribution";

export function AboutPage() {
  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">About</h1>

      <section aria-labelledby="about-what" className="space-y-2">
        <h2 id="about-what" className="text-xl font-semibold">
          What this site does
        </h2>
        <p>
          Once a day this site scans large listed companies, ranks them by market capitalisation and
          flags the ones whose latest completed close sits below a long-term standard-deviation
          regression channel (the -3 and -4 lines). Each flagged company gets an automated research
          summary. The Overview shows the result of the latest scan; the Quotes page lets you chart
          any listed security with the same channel.
        </p>
        <p>
          The header of the Overview shows <strong>Last successful scan</strong> in the Europe/Sofia
          time zone. It never shows the time of a failed or partial attempt as a success; a banner
          appears when the latest update is incomplete.
        </p>
        <p>
          The channel is a linear regression over the latest 2,500 daily bars with offsets of 1, 2,
          3 and 4 standard deviations. Charts are daily only; the range buttons change what you see,
          not the calculation.
        </p>
      </section>

      <section aria-labelledby="about-data" className="space-y-2">
        <h2 id="about-data" className="text-xl font-semibold">
          Data sources and delays
        </h2>
        <p>
          Prices, market capitalisations and company details come from Yahoo Finance delayed data.
          Quotes may be delayed and are always labelled with their time; a last close is labelled
          with its session date and is never labelled live. Foreign-exchange rates come from public
          reference rates. Data can be missing, stale or wrong; stale and unavailable values are
          marked in the tables.
        </p>
      </section>

      <section aria-labelledby="about-ai" className="space-y-2">
        <h2 id="about-ai" className="text-xl font-semibold">
          AI research
        </h2>
        <p>
          Research summaries are AI research generated from public sources, not financial advice.
          They can be incomplete or mistaken. Candidates that are not cleared by the checks carry a
          red "Avoid" tag and are not approved opportunities. Nothing on this site is a
          recommendation to buy or sell.
        </p>
      </section>

      <section aria-labelledby="about-attribution" className="space-y-2">
        <h2 id="about-attribution" className="text-xl font-semibold">
          Charts and attribution
        </h2>
        <p>Charts are drawn with the open-source library below.</p>
        <AttributionNotice className="text-sm" />
      </section>

      <section aria-labelledby="about-infra" className="space-y-2">
        <h2 id="about-infra" className="text-xl font-semibold">
          Infrastructure
        </h2>
        <p>
          The data and scheduled jobs run on Supabase (database and functions); the web app is
          served by Cloudflare. The site has no advertising and sets no tracking cookies for
          anonymous visitors.
        </p>
      </section>
    </div>
  );
}
