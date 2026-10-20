import type { FlagComponent } from "country-flag-icons/react/3x2";
import AU from "country-flag-icons/react/3x2/AU";
import BE from "country-flag-icons/react/3x2/BE";
import BM from "country-flag-icons/react/3x2/BM";
import BR from "country-flag-icons/react/3x2/BR";
import CA from "country-flag-icons/react/3x2/CA";
import CH from "country-flag-icons/react/3x2/CH";
import CN from "country-flag-icons/react/3x2/CN";
import DE from "country-flag-icons/react/3x2/DE";
import DK from "country-flag-icons/react/3x2/DK";
import ES from "country-flag-icons/react/3x2/ES";
import FI from "country-flag-icons/react/3x2/FI";
import FR from "country-flag-icons/react/3x2/FR";
import GB from "country-flag-icons/react/3x2/GB";
import HK from "country-flag-icons/react/3x2/HK";
import ID from "country-flag-icons/react/3x2/ID";
import IE from "country-flag-icons/react/3x2/IE";
import IN from "country-flag-icons/react/3x2/IN";
import IT from "country-flag-icons/react/3x2/IT";
import JP from "country-flag-icons/react/3x2/JP";
import KR from "country-flag-icons/react/3x2/KR";
import LU from "country-flag-icons/react/3x2/LU";
import MX from "country-flag-icons/react/3x2/MX";
import NL from "country-flag-icons/react/3x2/NL";
import NO from "country-flag-icons/react/3x2/NO";
import PE from "country-flag-icons/react/3x2/PE";
import SA from "country-flag-icons/react/3x2/SA";
import SE from "country-flag-icons/react/3x2/SE";
import SG from "country-flag-icons/react/3x2/SG";
import TH from "country-flag-icons/react/3x2/TH";
import TW from "country-flag-icons/react/3x2/TW";
import US from "country-flag-icons/react/3x2/US";
import UY from "country-flag-icons/react/3x2/UY";

const FLAGS: Record<string, FlagComponent> = {
  US,
  CN,
  CA,
  JP,
  GB,
  FR,
  CH,
  DE,
  TW,
  IE,
  IN,
  SE,
  HK,
  KR,
  NL,
  BR,
  AU,
  IT,
  SG,
  SA,
  ES,
  NO,
  MX,
  FI,
  DK,
  UY,
  PE,
  BE,
  TH,
  LU,
  ID,
  BM,
};

/** Yahoo assetProfile country names (as stored in companies.country) to ISO 3166-1 alpha-2. */
export const COUNTRY_CODES: Record<string, string> = {
  "United States": "US",
  China: "CN",
  Canada: "CA",
  Japan: "JP",
  "United Kingdom": "GB",
  France: "FR",
  Switzerland: "CH",
  Germany: "DE",
  Taiwan: "TW",
  Ireland: "IE",
  India: "IN",
  Sweden: "SE",
  "Hong Kong": "HK",
  "South Korea": "KR",
  Netherlands: "NL",
  Brazil: "BR",
  Australia: "AU",
  Italy: "IT",
  Singapore: "SG",
  "Saudi Arabia": "SA",
  Spain: "ES",
  Norway: "NO",
  Mexico: "MX",
  Finland: "FI",
  Denmark: "DK",
  Uruguay: "UY",
  Peru: "PE",
  Belgium: "BE",
  Thailand: "TH",
  Luxembourg: "LU",
  Indonesia: "ID",
  Bermuda: "BM",
};

const FRAME = "shrink-0 rounded-[2px] outline outline-1 -outline-offset-1 outline-foreground/15";

/** A 20x14 flag next to a country name. Decorative: the name is always shown, so it is aria-hidden. */
export function CountryFlag({ country }: { country: string | null | undefined }) {
  const code = country ? COUNTRY_CODES[country] : undefined;
  const Svg = code ? FLAGS[code] : undefined;
  if (!Svg) {
    return (
      <svg
        aria-hidden="true"
        width="20"
        height="14"
        viewBox="0 0 20 14"
        className={FRAME}
        data-flag="unknown"
      >
        <rect width="20" height="14" className="fill-muted-foreground/30" />
      </svg>
    );
  }
  return (
    <Svg
      aria-hidden="true"
      width={20}
      height={14}
      preserveAspectRatio="none"
      className={FRAME}
      data-flag={code}
    />
  );
}
