import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorHint } from "./error-hint";

describe("ErrorHint", () => {
  const cases: Array<[number, RegExp, RegExp]> = [
    [1012, /The Flex token has expired/, /Generate a new token in Client Portal/],
    [1015, /IBKR does not recognise the token/, /Copy the Current Token again/],
    [1014, /IBKR does not recognise the Query ID/, /Check the Query ID/],
    [1013, /because of the token.s IP restriction/, /Remove the IP restriction/],
    [1018, /1 request per second and 10 per minute/, /waits a minute/],
    [1019, /still generating the statement/, /retries automatically/],
    [-2, /cannot be decrypted/, /Link again/],
    [-6, /missing required sections or fields/, /select every section and field/],
  ];
  for (const [code, message, hint] of cases) {
    it(`code ${code} shows the message and the troubleshooting hint`, () => {
      render(<ErrorHint code={code} />);
      expect(screen.getByText(message)).toBeTruthy();
      expect(screen.getByText(hint)).toBeTruthy();
      expect(screen.getByText(`Error code ${code}`)).toBeTruthy();
    });
  }

  it("an unknown code still gets a generic explanation and nothing renders without a code", () => {
    render(<ErrorHint code={1999} />);
    expect(screen.getByText(/unknown error code \(1999\)/)).toBeTruthy();
    const { container } = render(<ErrorHint code={null} />);
    expect(container.textContent).toBe("");
  });
});
