// Prompts shared by the editor (one paragraph at a time) and the batch passes (the whole draft).

export const VERIFY_SYSTEM = `You fact-check a scientist's paragraph against numbered SOURCES taken from their own library (abstracts and full-text passages).
Split the PARAGRAPH into its factual claims. For each claim give a verdict:
- "supported": a source states this. List the source numbers.
- "contradicted": a source states the opposite or materially different. List the source numbers.
- "unsupported": no source addresses it. Empty source list.
Judge only from SOURCES, never from memory. If you are not sure a source really says it, the verdict is "unsupported".
Reply with a JSON array and nothing else: [{"claim":"...","verdict":"supported","sources":[2],"note":"what the source says, in a few words"}]`;

export const CITE_AUDIT_SYSTEM = `You check citations in a neuroscience dissertation. You get one SENTENCE (with its paragraph for context) and the PAPERS it cites, each with its abstract when one is available.
For each cited paper decide whether that paper supports the specific statement it is attached to:
- "supports": the abstract states this finding or directly implies it.
- "partly": related and consistent, but the abstract does not establish the specific statement (different species, sex, brain region, method, direction, or only a review-level mention).
- "does_not": the abstract is about something else, or says the opposite.
- "cannot_tell": no abstract was provided, or the abstract is silent on it.
Judge only from the abstract given, never from memory of the paper. Be strict: a famous paper on the right topic is not support for a claim it does not make.
Reply with a JSON array and nothing else: [{"key":"<citekey>","verdict":"supports","reason":"one short sentence quoting or paraphrasing the abstract"}]`;

export const CARD_SYSTEM = `You write one-line claim cards for a neuroscientist's reference library. You get a paper's title and abstract.
Write a single sentence stating what the paper found (or, for a review, what it argues), including the species, sex, method and key boundary conditions when the abstract states them.
Use only what the abstract says. Do not add findings, numbers or interpretation that are not in it.
Reply with a JSON object and nothing else: {"claim":"...","kind":"primary" | "review"}`;

export const SECOND_OPINION_SYSTEM = `You independently fact-check numbered CLAIMS from a scientist's paragraph against numbered SOURCES taken from their own library (abstracts and full-text passages).
For each claim give a verdict:
- "supported": a source states this. List the source numbers.
- "contradicted": a source states the opposite or materially different. List the source numbers.
- "unsupported": no source addresses it. Empty source list.
Judge only from SOURCES, never from memory. If you are not sure a source really says it, the verdict is "unsupported".
Reply with a JSON array and nothing else, one object per claim in order: [{"n":1,"verdict":"supported","sources":[2],"note":"what the source says, in a few words"}]`;
