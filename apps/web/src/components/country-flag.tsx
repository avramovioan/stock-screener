import type { FlagComponent } from "country-flag-icons/react/3x2";
import AT from "country-flag-icons/react/3x2/AT";
import AU from "country-flag-icons/react/3x2/AU";
import BE from "country-flag-icons/react/3x2/BE";
import BG from "country-flag-icons/react/3x2/BG";
import BM from "country-flag-icons/react/3x2/BM";
import BR from "country-flag-icons/react/3x2/BR";
import CA from "country-flag-icons/react/3x2/CA";
import CH from "country-flag-icons/react/3x2/CH";
import CN from "country-flag-icons/react/3x2/CN";
import CY from "country-flag-icons/react/3x2/CY";
import CZ from "country-flag-icons/react/3x2/CZ";
import DE from "country-flag-icons/react/3x2/DE";
import DK from "country-flag-icons/react/3x2/DK";
import EE from "country-flag-icons/react/3x2/EE";
import ES from "country-flag-icons/react/3x2/ES";
import FI from "country-flag-icons/react/3x2/FI";
import FR from "country-flag-icons/react/3x2/FR";
import GB from "country-flag-icons/react/3x2/GB";
import GR from "country-flag-icons/react/3x2/GR";
import HK from "country-flag-icons/react/3x2/HK";
import HR from "country-flag-icons/react/3x2/HR";
import HU from "country-flag-icons/react/3x2/HU";
import ID from "country-flag-icons/react/3x2/ID";
import IE from "country-flag-icons/react/3x2/IE";
import IN from "country-flag-icons/react/3x2/IN";
import IS from "country-flag-icons/react/3x2/IS";
import IT from "country-flag-icons/react/3x2/IT";
import JP from "country-flag-icons/react/3x2/JP";
import KR from "country-flag-icons/react/3x2/KR";
import LI from "country-flag-icons/react/3x2/LI";
import LT from "country-flag-icons/react/3x2/LT";
import LU from "country-flag-icons/react/3x2/LU";
import LV from "country-flag-icons/react/3x2/LV";
import MT from "country-flag-icons/react/3x2/MT";
import MX from "country-flag-icons/react/3x2/MX";
import NL from "country-flag-icons/react/3x2/NL";
import NO from "country-flag-icons/react/3x2/NO";
import PE from "country-flag-icons/react/3x2/PE";
import PL from "country-flag-icons/react/3x2/PL";
import PT from "country-flag-icons/react/3x2/PT";
import RO from "country-flag-icons/react/3x2/RO";
import SA from "country-flag-icons/react/3x2/SA";
import SE from "country-flag-icons/react/3x2/SE";
import SG from "country-flag-icons/react/3x2/SG";
import SI from "country-flag-icons/react/3x2/SI";
import SK from "country-flag-icons/react/3x2/SK";
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
  AT,
  BG,
  HR,
  CY,
  CZ,
  EE,
  GR,
  HU,
  LV,
  LT,
  MT,
  PL,
  PT,
  RO,
  SK,
  SI,
  IS,
  LI,
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

/** A 20x14 flag next to a country name (by Yahoo name or ISO code). Decorative: the name is always shown, so it is aria-hidden. */
export function CountryFlag({
  country,
  code: isoCode,
}: {
  country?: string | null | undefined;
  /** ISO alpha-2 code, for callers that already have it (wins over the name). */
  code?: string | undefined;
}) {
  const code = isoCode ?? (country ? COUNTRY_CODES[country] : undefined);
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
