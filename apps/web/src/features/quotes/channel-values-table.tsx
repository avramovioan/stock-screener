import type { Channel } from "@core/indicator.ts";
import { formatMoney, formatSessionDate } from "@/lib/format";
import { LINE_KEYS, LINE_TITLES } from "./chart-data";

/** Accessible alternative to the lines: the five end values and the last close. */
export function ChannelValuesTable({
  channel,
  close,
  date,
  currency,
}: {
  channel: Channel;
  close: number;
  date: string;
  currency: string;
}) {
  return (
    <table className="text-sm tabular-nums">
      <caption className="pb-1 text-left font-medium">{`Channel values at the latest bar (${formatSessionDate(date)})`}</caption>
      <thead>
        <tr>
          <th scope="col" className="pr-6 text-left">
            Line
          </th>
          <th scope="col" className="text-right">
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row" className="pr-6 text-left font-normal">
            Last close
          </th>
          <td className="text-right">{formatMoney(close, currency)}</td>
        </tr>
        {LINE_KEYS.map((k) => (
          <tr key={k}>
            <th scope="row" className="pr-6 text-left font-normal">
              {LINE_TITLES[k]}
            </th>
            <td className="text-right">{formatMoney(channel.end[k], currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
