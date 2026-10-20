import { z } from "zod";

// The enforced CSP has no 'unsafe-eval'. zod 4 probes for `new Function` before compiling validators; the probe is
// caught but still raises a securitypolicyviolation event, so switch the compiler off (plain interpreted parsing).
z.config({ jitless: true });
