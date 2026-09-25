# TypeSafe / Jev research note (rover use case)

Date: 2026-09-23. All claims cite fetched URLs (see Sources). Anything not backed by a fetched page is marked UNVERIFIED.

## TL;DR

- Jev does NOT generate free-form output. It returns typed judgments (Choice / Score / Noul) over state that your code supplies. "System One models do not write replies, produce code, or generate explanations of their reasoning." [S1] Jaggedness page: "Not trained for text generation; very slow and ineffective when forced." [JAG]
- Therefore "the AI generates a JSONL of driving commands" is architecturally wrong for Jev. Code (A*, sampling, heuristics) must generate candidates; Jev ranks/verifies/scores them.
- Pricing: $0.042 per 1M input tokens, output free. [MODELS] Limits: 64k tokens/request, 32k for state + longest question; 250k tok/s, 1,200 req/min. [MODELS]
- JS SDK: `@typesafe-ai/sdk` v0.6.0 (2026-09-15), Node >= 20, zero runtime deps. [JSSDK][JSCL-CHG][NPM]
- Not deterministic: repeated identical calls vary slightly (mean per-question prob std ~0.01). No caching guarantee documented. [CONS-N][CONS-C]
- Jev is weak at counting, math, numeric literals (hex/RGB/binary), date ordering, multi-hop reasoning. [JAG] Don't ask it to compute distances/times; compute them in code and ask it about semantics.

## 1. Generation vs judgment (architecture-determining)

Verified facts:

- "System One models return structured, typed decisions rather than free-form text ... do not write replies, produce code, or generate explanations of their reasoning." [S1]
- Three primitives only: Choice ("which of these options?"), Score ("which level?"), Noul ("is this true?"). [PRIM]
- "Every output is constrained to the supplied options, the model returns a full probability distribution over those options rather than inventing a value outside the schema." [HOW]
- "Code handles deterministic work and owns the control flow. The model appears only where the system needs programmable common sense." [HOW]
- "Jev accepts text input only. It evaluates strings, JSON objects, and arrays of text." [S1][STATE] (no images/heightmap rasters; must serialize terrain as text/JSON).
- Questions in one request are evaluated independently and in parallel; "one question's result cannot become hidden context for another." [HOW]

Conclusion: Jev cannot emit a command sequence, waypoint list, or any string not present in the criteria you supplied. The only way to "select a path" is: code enumerates N candidate paths -> Choice over N (max 255 options [API][CHOICE]) or one Noul/Score per candidate. The only "generative" trick is Choice over a large enumerated option set (cookbook picks 1 of 182 skills [IDX]).

Also: Jev "reads instructions at face value", "treats dates as text", "does not count reliably", "cannot reliably reconstruct exact numbers by interpolating between score levels", and "Recommended to implement mathematical logic in code". [JAG] So terrain math (slope, path length, ETA) must be code-side; feed Jev pre-computed, semantically labelled facts ("slope: steep", "length: 340 m, 2.1x straight-line").

## 2. Limits, pricing, rate limits, latency

From [MODELS] (verbatim table rows):

- Models: `jev-1.13.0`; aliases `jev-latest` and `jev-preview` both -> `jev-1.13.0`.
- "Price (per Btok / per Mtok) | $42 / $0.042". Charged per input token; output tokens free.
- "Context length | 64k tokens per request; 32k tokens for `state` plus the longest question".
- "Rate limits | 250,000 tokens per second / 1,200 requests per minute" — noted as adjusting dynamically, "can change without notice".

From [API]:

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, JSON body `{state, model, questions}`.
- Choice: max 255 options. Score: 2-10 levels. No documented cap on questions per request.
- Errors: 401, 422 (validation), 429 (rate limit), 529 (overloaded); backoff advised.
- Response includes `usage.input_tokens` / `output_tokens`.

Latency: how-to-build page says queries complete in "roughly 100 milliseconds" [HOW]. Parallel-questions cookbook: 13 questions over a ~53,777-char state in one call = 0.27 s, $0.000497; sequential 13 calls = 2.71 s, $0.006090 [PAR]. Rerank cookbook: 1,200 small Noul calls = 1,536,002 input tokens = $0.0645 [RERANK].

Cost intuition for rover: a 2k-token state with ~10 questions ≈ 2.5k tokens ≈ $0.0001/request. 10,000 user submissions/day at 3 req each ≈ $3/day. Budget is not the constraint; state-size discipline (accuracy, "context rot" [JAG]) is.

Free tier / credits: UNVERIFIED (not in quickstart [QS] or models page). API key from https://console.typesafe.ai/keys [QS].

## 3. JS SDK

- Package `@typesafe-ai/sdk`, `npm install @typesafe-ai/sdk`, Node 20+, env `TYPESAFE_API_KEY`. [JSSDK]
- Version 0.6.0 (2026-09-15); 0.5.7 (2026-09-11) was initial public launch; 0.6.0 breaking: `Score.criteria` is an ordered array, not int-keyed dict. [JSCL-CHG] npm `latest` = 0.6.0, engines node>=20, no runtime deps. [NPM]
- Client config (`TypeSafeClientConfig`): `apiKey` (fallback `TYPESAFE_API_KEY`), `baseURL` (fallback `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai`), `defaultModel` (fallback `TYPESAFE_DEFAULT_MODEL`, then `jev-latest`), `timeout` per attempt default 10000 ms, `retry`, `logLevel` default `warn`, `defaultHeaders`, `fetch`, `dangerouslyAllowBrowser` (off by default). [JSCFG]
- `systemOne<Q>(request, options?): APIPromise<SystemOneResult<Q>>`; answers typed by question key; throws on invalid questions, non-2xx after retries, timeout, abort. [JSCL]
- Helpers: `choice(instructions, criteria)`, `score<T>(instructions, criteria)` (>=2 entries, indexed from 0, entries may be null), `noul(instructions?, criteria?)` with `{true?, false?}`. [JSSCORE][JSNOUL]

Minimal example (verbatim from [JSSDK]):

```ts
import { choice, TypeSafeClient } from '@typesafe-ai/sdk'
const client = new TypeSafeClient()
const response = await client.systemOne({
  state: { document: 'I was charged twice. Please fix this ASAP.' },
  questions: {
    category: choice('What is this ticket about?', { billing: null, technical: null, other: null }),
  },
})
console.log(response.answers.category.choice)
```

Shapes:

- State: string | JSON object | array of text; prefer an object with descriptive keys; reference nested fields in instructions with dot notation (`ticket.messages[0].text`). [STATE][PRIM]
- Instructions/criteria may be JSON objects/arrays, not only strings (e.g. `{what, not_for, examples}` per option; Score levels as `{summary, signals}`; Noul `{true:{...}, false:{...}}`). [ADV][CHOICE]
- Choice answer: `{type:"choice", choice, probabilities:{opt:p}, confidence}` (probs sum to 1; `choice` = argmax). [CHOICE]
- Score answer: `{type:"score", score, confidence, legend:{"0":..}, probabilities:{"0":p,..}}`; `score` = expected value Σ level×p, range 0..levels-1, fractional allowed. [SCORE]
- Noul answer: `{type:"noul", noul: 0..1}` (no separate confidence field). [NOUL]
- Confidence (Choice/Score): collapse of the distribution; 3-option approximation "(3 × largest probability − 1) / 2". Full `probabilities` returned so you can define your own. [CONF]
- Noul thresholds guidance: 0.8+ when false positives costly, lower when misses costly, 0.2-0.8 -> human review. [NOUL]
- Caveats: "No guaranteed structural invariants (e.g., P(noul) ≠ 1 − P(not_noul))"; thresholds tuned on one primitive don't transfer; Choice is relative, Noul absolute. [JAG]

## 4. Proposed decompositions (code generates, Jev judges)

Common precondition: code owns the terrain model. Per submission, code computes: A* (or several variants: shortest / least-slope / safest) over heightmap, path length, straight-line distance, max/mean slope, hazard cells crossed, estimated time from a kinematic model, battery/energy estimate. Serialize a compact, semantic summary (labels, not raw grids) as state — Jev is bad at numbers, counting, and large distracting state [JAG].

Design rule from docs: put all questions that share a state in ONE request (parallel, near-zero extra latency, only extra question tokens) [PRIM][FAN][COMP]; separate requests only when the state differs (per-candidate comparisons; rerank cookbook uses one request per candidate with no cross-candidate visibility [RERANK]).

### Option A — "Single-shot feasibility + tie-break weights" (cheapest, 1 request/submission)

State: `{rover: {status, battery, terrain_capabilities_text}, destination: {distance_m, bearing, terrain_summary}, best_path: {length_m, detour_ratio, max_slope_label, hazards: [...], eta_label}, mission_context: "..."}`. Questions (one request):

- `feasible` Noul: "Can the rover realistically reach this destination given the path summary?" with explicit true/false criteria.
- `too_near` Noul / `too_far` Noul (or one Choice `distance_band: {too_near, reasonable, too_far}`).
- `distance_confidence` Score 0-4 ("How reliable is the computed distance/path? 0 = path crosses unknown/hazard cells ... 4 = fully mapped flat route").
- `time_confidence` Score 0-4 (same, for ETA).
- `risk` Score 0-3. Code: reject if `feasible.noul < 0.2`; human/vote review if 0.2-0.8 [NOUL]; use `distance_confidence.score / 4` and `time_confidence.score / 4` as tie-break weights (composite-scoring pattern normalizes by max level [COMP]). Cost: ~1.5-3k tokens ≈ $0.0001. Requests: 1.

### Option B — "Code proposes K paths, Jev picks" (2 requests/submission)

Request 1 = Option A gate (feasibility/distance band). If it passes: Request 2: state = destination + K (3-8) candidate path summaries generated by different planners (shortest, smoothest, hazard-avoiding). Questions:

- `best_path` Choice over `{path_0..path_{K-1}}` with structured criteria per option (`{length, slope, hazards, eta}` as JSON [ADV]) — `probabilities` give a full ranking; `confidence` low => fall back to code's default (confidence-routing) [CONF].
- Per-candidate `safe_k` Noul for each k (still one request; independent evaluation) for an absolute safety signal (Choice is relative-only [JAG]).
- `distance_confidence`, `time_confidence` Scores conditioned on the chosen family of paths. Cost: ~3-5k tokens ≈ $0.0002. Requests: 2 (or 1 if you skip the gate and let `feasible` sit alongside — speculative fan-out pattern [FAN]). Caveat: K options with near-identical numeric summaries will confuse Jev (numeric weakness [JAG]); emphasize qualitative differences in criteria.

### Option C — "Segment-level verification of a code-generated command sequence" (N+1 requests or 1 fat request)

Code generates the JSONL of driving steps (A* -> waypoint smoothing -> command compiler). Jev verifies, doesn't write.

- Chunk the sequence into M segments (e.g. by terrain type change). Either one request with M Noul questions (`segment_k_safe`) referencing `steps[k]` via dot notation [PRIM] — cheapest; or one request per segment with only that segment's context (rerank-style isolation [RERANK]) when the full sequence exceeds useful state size.
- Add `sequence_plausible` Noul and `risk` Score globally. Requests: 1 (batched) or M+1 (isolated). Cost: batched ≈ same as A; isolated ≈ M × 1k tokens. Use only if segments carry semantic content (hazard labels, terrain descriptions); Jev will not validate arithmetic consistency of steps [JAG].

Recommendation: start with A (1 req), add B's Request 2 only if multiple planners exist. Estimated requests per user submission: 1-2; per 1,000 submissions ≈ $0.1-0.3. Rate limit 1,200 req/min is far above expected load. [MODELS]

Vote tie-break: use `score/(levels-1)` normalized Scores as weights (composite pattern [COMP]); gate on `confidence` (Choice/Score) or Noul band before trusting a weight [CONF][NOUL].

## 5. Determinism / caching

- No determinism or caching guarantee documented on models, API, or primitives pages. [MODELS][API][CHOICE]
- Consistency cookbooks measure repeated identical inputs (with a fresh `uid` field per call to force independent draws): Noul mean per-question std 0.0102 (one question ranged 0.43-0.53) [CONS-N]; Choice mean std 0.0098, max single-label std 0.0515; "small probability changes can still switch the top label when two labels are close"; with a 0.60 threshold + `uncertain` band, agreement 99.2%. [CONS-C]
- Implication: treat Jev as stochastic-but-tight. Cache results yourself keyed by hash(state, questions, model) to guarantee same-answer-for-same-submission and to save tokens. Pin `jev-1.13.0` rather than `jev-latest` for reproducibility across model bumps [MODELS]. Use uncertainty bands, not raw argmax, for vote-affecting decisions.
- Server-side caching: UNVERIFIED (nothing documented).

## Open items / UNVERIFIED

- Free tier, credits, billing minimums.
- Exact p50/p95 latency for small states (only "roughly 100 ms" [HOW] and 0.27 s for a 53k-char state [PAR]).
- Whether `usage.input_tokens` counts questions + state together (implied by pricing but not stated).
- Behavior of Choice with >~50 numerically-similar options (jaggedness page only says accuracy degrades with counting/size, not a number).

## Sources

- [IDX] https://docs.typesafe.ai/llms.txt
- [S1] https://docs.typesafe.ai/concepts/system-one.md
- [HOW] https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
- [STATE] https://docs.typesafe.ai/concepts/state.md
- [PRIM] https://docs.typesafe.ai/primitives.md
- [CHOICE] https://docs.typesafe.ai/primitives/choice.md
- [SCORE] https://docs.typesafe.ai/primitives/score.md
- [NOUL] https://docs.typesafe.ai/primitives/noul.md
- [ADV] https://docs.typesafe.ai/primitives/advanced.md
- [CONF] https://docs.typesafe.ai/confidence.md
- [API] https://docs.typesafe.ai/api.md
- [MODELS] https://docs.typesafe.ai/models.md
- [JAG] https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- [QS] https://docs.typesafe.ai/introduction/quickstart.md
- [JSSDK] https://docs.typesafe.ai/sdk/javascript.md
- [JSCL] https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient.md
- [JSCFG] https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md
- [JSCL-CHG] https://docs.typesafe.ai/sdk/javascript/changelog.md
- [JSSCORE] https://docs.typesafe.ai/sdk/javascript/api/functions/score.md
- [JSNOUL] https://docs.typesafe.ai/sdk/javascript/api/functions/noul.md
- [NPM] https://registry.npmjs.org/@typesafe-ai/sdk/latest
- [COMP] https://docs.typesafe.ai/patterns/composite-scoring.md
- [FAN] https://docs.typesafe.ai/patterns/fan-out.md
- [PAR] https://docs.typesafe.ai/cookbooks/parallel_questions.md
- [RERANK] https://docs.typesafe.ai/cookbooks/rerank_typesafe.md
- [CITE] https://docs.typesafe.ai/cookbooks/citation_check.md
- [CONS-N] https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md
- [CONS-C] https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md
- [SMART] https://docs.typesafe.ai/demos/smart-home.md
