# Std Dev Channel (`stddevchn.pine`) - semantic analysis and fixtures

Scope: analysis only. Fixtures: `docs/discovery/fixtures/stddevchn-synthetic.json`, generated with a throwaway double-precision Node script that is a line-for-line port of the Pine loops. Values are JS `JSON.stringify` shortest round-trip doubles.

## 1. Line-by-line walkthrough

| Lines | Meaning |
|---|---|
| 2 | `overlay=true`; one indicator drawing lines on the price chart. |
| 3-4 | `length` (script default 128, min 1, max 5000), `src` (default close). App default: length 2500, source close. |
| 6-13 | Four Boolean "mode" inputs plus four float multipliers. Script defaults 1,1,2,2 (all positive). Lower multipliers are applied as `-mult*sd`, so app magnitudes 3 and 4 give -3 sd / -4 sd. Mapping: `upprinp`/`upprmltinp` = Upper+1, `upprinp2`/`upprmltinp2` = Upper+2, `lwrinp`/`lwrMultInput` = Lower-1, `lwrinp2`/`lwrmultinp` = Lower-2. |
| 15-27 | Colours, Pearson label toggle, extend left/right mapped to `exs`. App default: right only. |
| 29-48 `slpclc` | Returns `[na,na,na]` unless `barstate.islast` and `length>1`. Otherwise loops `i=0..length-1` with `val=source[i]` (i=0 newest bar), `per=i+1`; accumulates sumX, sumY, sumX^2, sumXY. `slope=(L*sumXY-sumX*sumY)/(L*sumXSqr-sumX^2)`; `average=sumY/L`; `intercept=average-slope*sumX/L+slope`. |
| 50-52 | `s,a,i = slpclc`; `st_price=i+s*(L-1)`; `end_price=i`. |
| 53-59 | `base_line` created once (`var`), then re-pointed on each bar: x1=`bar_index-L+1`, y1=st_price, x2=`bar_index`, y2=end_price. On non-last bars st_price is na, so nothing is created and the `else` branch calls setters on a na id (behaviour not verified from the reference; irrelevant to the app). |
| 61-89 `devcalc` | `periods=L-1`; `daY=intercept+slope*periods/2`; `val` starts at `intercept`; loop j=0..L-1 inclusive (L iterations): upDev=max(0,high[j]-val); dnDev=max(0,val-low[j]); `dxt=source[j]-average`; `dyt=val-daY`; residual=`source[j]-val`; accumulate residual^2, dxt^2, dyt^2, dxt*dyt; `val+=slope`. `stdDev=sqrt(acc/(periods==0?1:periods))`; `pearsonR=(dsxx==0 or dsyy==0)?0:dsxy/sqrt(dsxx*dsyy)`. High/low come from the global series, not from `source`. |
| 91-119 `devcalc2` | Verbatim copy (names suffixed 2). |
| 121-141 | Set 1: `upprst/upprend = st/end + (upprinp ? mult1*sd : upDev)`; `lwrst/lwrend = st/end + (lwrinp ? -mult*sd : -dnDev)`. Lines from x=`bar_index-L+1` to `bar_index`. Two `linefill.new` calls (cosmetic, created on every bar). |
| 143-161 | Set 2 with `stdDev2/upDev2/dnDev2`; same formulas with set-2 inputs, but x1 = `bar_index-L+2`. |
| 162-165 | Optional Pearson label at x=`bar_index-L+1`, y=`lwrst_price`. |
| 167-177 | `ta.crossover/crossunder(close, <end price>)` alerts. |

## 2. Hypotheses

**H1 - CONFIRMED.** x_i = i+1 with i=0 the newest bar (`source[0]` is the current bar). OLS: slope b = (L*Sxy - Sx*Sy)/(L*Sxx - Sx^2); fitted y(x) = ybar + b(x - xbar), xbar = Sx/L = (L+1)/2. y(1) = ybar - b*Sx/L + b = `intercept`. So `end_price` is the fit at the newest bar and `st_price = i + s*(L-1)` = y(L) is the fit at the oldest bar of the window.

**H2 - CONFIRMED.** Rising (left < right) <=> end_price > st_price <=> s*(L-1) < 0 <=> s < 0. Fixtures: F1 (rising closes) has slope -1, F2 (falling) slope +1. Implement the trend as `endPrice > stPrice` (with the epsilon in section 6), never on raw slope sign.

**H3 - CONFIRMED.** `val` at step j = intercept + j*slope = y(j+1). Residual = source[j]-val. stdDev = sqrt(sum(res^2)/(L-1)): divisor L-1, not L, and not the std of the source. upDev/dnDev = max(0, max_j(high[j]-val_j)) / max(0, max_j(val_j-low[j])); they use high/low even if source is not close. Both are non-negative. Mode false uses `+upDev` / `-dnDev` and ignores the multiplier.

**H4 - CONFIRMED.** Bodies are identical token by token (only local names differ), same inputs `src,length,s,a,i`, so outputs are bit-identical. The app can compute once.

**H5 - CONFIRMED.** Right end (latest bar): upper1=end+m1*sd, upper2=end+m2*sd, lower1=end-3*sd, lower2=end-4*sd (mode true). Left end identical with st_price. The offsets are equal at both ends, so every line has the same slope as the base line.

**H6 - CONFIRMED, quantified.** Set-2 lines run from x=N-L+2 to N (L-2 bars apart, so they span L-1 bars inclusive) but y1 is the st_price-based value belonging to x=N-L+1. Drawn slope per bar = (end-st)/(L-2) versus the true (end-st)/(L-1): factor (L-1)/(L-2). Values at x=N (the last bar) are exact. Examples:
- F4 (L=8): true slope 0.7107/bar, set-2 drawn slope 0.8292/bar (x1.1667); 5 bars to the right, set-2 lines sit 0.592 above an exact extension.
- L=2500: factor 1.00040032; with a slope of 0.05/bar, a 500-bar right extension differs by 500*0.05/2498 = 0.0100 (0.04% of the 25.0 rise). At the window start the set-2 line begins one bar late at height st2.
- If extend-left is enabled the discrepancy applies symmetrically. L=2 would make set 2 degenerate (x1==x2); chart code needs L>=3.
Reproduce as is (brief 5.3), but use the exact end values for threshold decisions.

**H7 - CONFIRMED.** Mode true: mult*sd; false: max high/low deviation (set 1 and 2 then use the same upDev/dnDev, so F5 has identical upper1/upper2 and lower1/lower2). The line is drawn either way. Lower mode false uses `-dnDev` with no multiplier.

**H8 - CONFIRMED, with additions.** `not barstate.islast` gives na: one channel over the newest L bars. Fewer than L bars: `source[i]` is na, so sumY is na, so slope/average/intercept are na and nothing is drawn (F8 expected null). Additions: (a) `barstate.islast` is also true on every realtime tick of the forming bar, so TradingView uses the unconfirmed live candle intraday; the app must use the latest completed daily candle and parity checks should be done after the close. (b) The alert series are na on prior bars, so alerts can only fire on realtime bars.

**H9 - CONFIRMED.** Alerts compare `close` to the end prices, are informational, and feed nothing else. They are strict crossings against the previous bar; the brief's rules (close <= lower, close >= upper) are level tests defined independently.

**H10 - CONFIRMED with a sign finding.** daY = mean of fitted values (intercept + slope*(L-1)/2). dxt = y - ybar, dyt = yhat - mean(yhat), so r = corr(source, fitted). The fitted value is linear in j with coefficient `slope`, and slope has the sign of corr(y, j), so corr(y, yhat) = sign(slope)*corr(y,j) = |corr(y,j)| >= 0. The reported r is NOT signed: falling (F2) and rising (F1) channels both report +1. It is 0 if dsxx==0 or dsyy==0 exactly. With floating noise on constant series it can be garbage (observed 0.48 and -1, section 6).

## 3. Orientation diagram

```
chart (oldest -> newest)   |<-------------- window (L bars) -------------->|
bar_index                  N-L+1 ........................................ N
source[] offset i          L-1   ........................................ 0
script x = i+1             L     ........................................ 1
fit value                  st_price = i + s*(L-1)                         end_price = i
set-1 line x range         N-L+1 -------------------------------------->  N
set-2 line x range               N-L+2 ------------------------------->  N   (starts one bar late)
visually rising  <=>  end_price > st_price  <=>  s < 0
```

## 4. Formulas for the TypeScript port

Input arrays oldest to newest, n bars; `src(i)=close[n-1-i]` (same for high/low). Require 2 <= L <= n, else null. Keep this exact accumulation order.

```
sumX=sumY=sumXSqr=sumXY=0
for i=0..L-1: v=src(i); per=i+1; sumX+=per; sumY+=v; sumXSqr+=per*per; sumXY+=v*per
slope=(L*sumXY - sumX*sumY)/(L*sumXSqr - sumX*sumX)
average=sumY/L
intercept=average - slope*sumX/L + slope        // left to right
stPrice=intercept + slope*(L-1);  endPrice=intercept
periods=L-1; daY=intercept + slope*periods/2; val=intercept
upDev=dnDev=acc=dsxx=dsyy=dsxy=0
for j=0..periods:
  p=high(j)-val; if p>upDev: upDev=p
  p=val-low(j);  if p>dnDev: dnDev=p
  p=src(j); dxt=p-average; dyt=val-daY; p=p-val
  acc+=p*p; dsxx+=dxt*dxt; dsyy+=dyt*dyt; dsxy+=dxt*dyt
  val+=slope
stdDev=sqrt(acc/(periods==0?1:periods))
pearsonR=(dsxx==0||dsyy==0)?0:dsxy/sqrt(dsxx*dsyy)
off(mode,mult,sign,dev) = mode ? sign*mult*stdDev : sign*dev
line.start=stPrice+off, line.end=endPrice+off   (upper sign +1, lower sign -1; lower mult = positive magnitude)
set-2 x1 = windowStartBar+1
```
Plain math: slope = Cov(x,y)/Var(x) with x=i+1; sd = sqrt(SSE/(L-1)). `slope*periods/2` is `(slope*periods)/2`.

Cross-check F4 (L=8): script-order slope -0.7107142857142944 vs exact BigInt-rational -0.7107142857142857 and mean-centred -0.7107142857142851 (relative errors 1.2e-14 and 9e-16); intercept 105.02500000000005 vs exact 105.02499999999999 and centred 105.025 (5e-16 / 1e-16). Agreement is at least 13 significant digits for the slope and 15 for the intercept. The ~1e-14 slope error comes from cancellation in the script's numerator; a faithful port reproduces it, so tests should use the script-order values with tight tolerance.

## 5. Validation bounds

- Script input: min 1, max 5000. `length<=1` gives all na. L=2 is an exact fit with sd=0 and a degenerate set-2 line.
- Recommend: integer, hard minimum 3 (sd defined and set-2 line defined), warning below 30, maximum 5000 (script maxval and `max_bars_back(5000)`), default 2500. Reject non-integers and NaN. Multipliers/magnitudes: finite and > 0 (zero collapses a line onto the base; negatives would invert the sign convention). Pine itself does not constrain them.
- Fewer than L valid bars: "insufficient data" (no channel, not an error).

## 6. Floating point and tolerance

Pine floats are IEEE-754 doubles (stated in the task; not confirmed in the fetched pages). A JS port with the same operation order gives the same results (JS never fuses multiply-add; `Math.sqrt` is correctly rounded). Even with a different summation order expect <= 1e-13 relative disagreement at L=2500 (sumX^2 about 1e13, denominator cancellation factor about 4; numerator cancellation grows for nearly flat series).

Proposed tolerances:
1. Port vs fixtures (identical inputs): relative 1e-12 with absolute floor 1e-9 on every level; for sd/Pearson use absolute 1e-9 when the expectation is about 0 (F9 shows sd=1.6e-14 on a constant series).
2. Port vs TradingView with identical bars: TradingView displays values rounded to the symbol precision of p decimals, so accept |diff| <= 0.5*10^-p + 1e-9. Read full precision where possible (e.g. a Pine label with `str.tostring`).
3. Data-source differences (provider split/dividend adjustment, different vendors, live bar, missing or extra sessions, historical price rounding) are not algorithmic. Report them separately: if levels differ by more than about 0.1% relative while input bars differ, log "data difference" with the bar diff; do not widen the algorithmic tolerance. The 0.1% value is a judgement call; first compare bars one by one.

Degenerate flat series (important): non-integer constants produce noise. 123.456 x5 gives st/end differing by 1e-14; 2500 bars of 123.456 give end-st = 2.4e-11 (would classify as rising) and pearsonR 0.49; a constant 1/3 gives r=-1. The trend rule must therefore be `endPrice - stPrice > eps*max(1,|endPrice|,|stPrice|)` with eps about 1e-9, so constant series are flat. Fixture F9 records the raw noisy values; the application-level expectation is "not rising".

## 7. "Latest 2,500 valid daily bars"

Drop bars with null/NaN close (and null high/low when needed), take the most recent L valid completed daily bars in chronological order. The newest is offset 0; the oldest is offset L-1 = 2499 bars back. Exclude the in-progress candle. Fewer than L valid bars: no channel (H8). Fixture F7 shows older bars have no effect.

## 8. Chart reproduction requirements

Five segments (base, upper1, upper2, lower1, lower2). Base and set 1: (N-L+1, st+off) to (N, end+off). Set 2: (N-L+2, st2) to (N, end2), with the st-based y values (H6). Extend right with each segment's own drawn slope (set 2 steeper by (L-1)/(L-2)). Right margin: the line docs limit bar-index x-coordinates to about `bar_index+500`; a modest empty margin suffices. Dashed 1px lines; linefills between upper1-base and base-lower1 are cosmetic. Lines are drawn regardless of mode flags. Optional Pearson label at the window start x, y = lower1 start.

## 9. Fixtures (JSON)

F1 rising linear (slope -1, sd 0, r 1); F2 falling (slope +1); F3 flat (r 0); F4 noisy L=8 modes true (slope -0.7107142857142944, average 102.53750000000001, intercept 105.02500000000005, st 100.04999999999998, sd 0.45101925385391056, r 0.9680403688657844, upDev 1.3071428571428214, dnDev 1.6035714285714704); F5 modes false (upper 101.3571428571428 to 106.33214285714287, lower 98.44642857142851 to 103.42142857142858); F6 rising with lower-4 end -1.6996 (zero filter); F7 equals F4 (asserted identical); F8 insufficient data (expected null); F9 float-noise constant. Full values are in the JSON.

## 10. Reference pages used

- https://www.tradingview.com/pine-script-docs/language/operators/ : `[]` offset 0 is the current bar; out-of-history offsets return na. Dynamic offsets in loops are not addressed.
- https://www.tradingview.com/pine-script-docs/concepts/bar-states/ : `barstate.islast` is true on the last chart bar, including every realtime update.
- https://www.tradingview.com/pine-script-docs/visuals/lines-and-boxes/ : bar_index coordinates limited to about `bar_index+500` / `bar_index-10000`; `extend.right` extends the line beyond its end.
- https://www.tradingview.com/pine-script-reference/v5/ : fetch returned only navigation (script-rendered page).

Not verified from the reference: `max_bars_back` semantics, `line.set_xy1/2` with na ids, exact `ta.crossover/crossunder` definitions, na propagation in arithmetic, the IEEE-754 statement, and that extend.right follows the segment's own slope (well-known behaviour, not confirmed in the fetched text).
