import type { ReactNode } from "react";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const muted = "text-muted-foreground";

export function HowItWorksPage() {
  return (
    <article className="mx-auto flex w-full max-w-[760px] flex-col gap-7 text-base leading-relaxed">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-[0.01em]">How this screener works</h1>
        <p className={muted}>
          A plain description of what the list is, how companies get on it, and what the AI research
          does and does not do. Nothing here is investment advice.
        </p>
      </header>

      <Section id="hiw-watched" title="1. Which companies are watched">
        <p>
          Every trading day the screener reads the listings of 25 exchanges and keeps the companies
          worth at least <strong>US$50 billion</strong>. Each company is tracked once, on its home
          exchange, and only its ordinary shares count: depositary receipts, second listings, bonds,
          funds and certificates are left out. A company also needs at least{" "}
          <strong>ten years of price history</strong>, because the channel below needs that much
          data. Today that is about 400 companies.
        </p>
      </Section>

      <Section id="hiw-channel" title="2. The channel and the −3 line">
        <p>
          For each company the screener fits a straight-line trend through the last 2,500 daily
          closes (about ten years) and measures how far prices usually stray from it. Lines are
          drawn at one, two, three and four of those typical deviations below and above the trend. A
          company appears on the Overview on the day it{" "}
          <strong>closes at or below its −3 line</strong>; reaching the −4 line is noted as well.
          Each card also says whether the price reached the −4 line ("Reached −4") or not yet ("Wait
          for −4").
        </p>
        <p className={muted}>
          The lines are statistics about the past price, not predictions. A long slide can keep a
          company below its −3 line for months.
        </p>
      </Section>

      <Section id="hiw-scan" title="3. The daily scan">
        <p>
          The scan runs at 10:00 Sofia time on days with a new market close, including Mondays for
          Asian exchanges that traded that morning. It refreshes prices, recomputes every channel,
          ranks the companies by market value and publishes the list. The time of the last published
          list is shown at the top right of the Overview; a banner appears when a scan could not
          process every company.
        </p>
      </Section>

      <Section id="hiw-research" title="4. AI research, on request">
        <p>
          A cheap price alone does not say whether something is wrong with the business. Anyone can
          press <strong>Scan with AI</strong> on a card. The research collects the company's recent
          filings and news, asks an AI model to look for signs of bankruptcy risk or lasting damage
          to the business, and checks that every claim is backed by a cited source. The result is
          shared with every visitor and is labelled with the model and the time. One scan per
          company every <strong>72 hours</strong>; the free AI budget is limited, so scans can pause
          for the day.
        </p>
        <p>
          You can also run the same evaluation yourself: the ChatGPT, Claude, Grok and Gemini
          buttons copy the prompt and open that assistant, and the copy button just copies it.
        </p>
        <p className={muted}>
          Outcomes: Cleared (nothing material found), Cleared with caution (something to read
          first), Not cleared (a material risk was found), or Could not research (not enough
          evidence). Trading is up to you in every case.
        </p>
        <p>
          Next to each company's name a tag sums it up. <strong>Strong buy</strong>: the AI check
          cleared it and it is one of the ten largest or has reached its −4 line.{" "}
          <strong>Consider</strong>: cleared, but only at the −3 line, or cleared with caution.{" "}
          <strong>Unchecked</strong>: no finished AI check yet. <strong>Avoid</strong>: the check
          found a material risk or could not reach a conclusion.
        </p>
      </Section>

      <Section id="hiw-notifications" title="5. Notifications">
        <p>
          If you turn on push notifications, you hear from the screener only when a company is{" "}
          <strong>new on the list</strong> compared with the previous day. Companies that stay on
          the list, or leave it, do not trigger a message.
        </p>
      </Section>

      <Section id="hiw-data" title="6. Data and limits">
        <p>
          Prices and company data come from Yahoo Finance and are delayed. Filings come from SEC
          EDGAR where available. Portfolio data comes only from your own IBKR Flex statements. The
          site keeps no order-placement connection to any broker: "Trade on IBKR" opens IBKR's own
          site and offers a prompt you can paste there.
        </p>
      </Section>
    </article>
  );
}
