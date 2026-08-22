import { z } from "zod";

const finite = z.number().finite();
const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const categoryIds = ["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"] as const;
const indicatorIds = ["netProgressionPer90", "shootingLuckOrGoalkeeperImpact"] as const;

const expectedReadouts: Record<(typeof categoryIds)[number], readonly string[]> = {
  outsideShot: ["outsideBoxShots", "outsideBoxXg", "outsideBoxXgot", "outsideBoxShotQualityGoals"],
  boxThreat: ["inBoxShots", "inBoxXg", "inBoxXgot", "inBoxFinishingGoals", "inBoxFinishingPer90", "deepBoxZoneScore"],
  dangerZone: ["successfulDribblesPer90", "failedDribblesPer90", "dribbleMarginPer90", "dribbleAttempts", "dribbleSuccessRate", "dangerZoneDensity"],
  combinedDuel: ["groundDuelAttempts", "groundWonPer90", "groundLostPer90", "duelMarginPer90", "groundDuelWinRate", "aerialDuelAttempts", "aerialWonPer90", "aerialLostPer90", "aerialMarginPer90", "aerialDuelWinRate"],
  spaceControl: ["ccaAreaPct", "dangerZoneDensity"],
  forwardPress: ["recoveries", "recoveriesPer90", "finalThirdPossessionsWon", "finalThirdPossessionsWonPer90"],
};

const comparisonSchema = z.object({
  state: z.enum(["available", "unavailable", "not_applicable"]), median: finite.nullable(), rank: z.number().int().positive().nullable(), percentile: finite.min(0).max(100).nullable(), population: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const all = [value.median, value.rank, value.percentile];
  if (value.state === "available" && (all.some((item) => item === null) || value.population < 1 || (value.rank !== null && value.rank > value.population))) ctx.addIssue({ code: "custom", message: "available comparison must be complete" });
  if (value.state === "unavailable" && ((value.rank !== null || value.percentile !== null) || (value.population === 0 && value.median !== null) || (value.population > 0 && value.median === null))) ctx.addIssue({ code: "custom", message: "unavailable comparison is inconsistent" });
  if (value.state === "not_applicable" && (all.some((item) => item !== null) || value.population !== 0)) ctx.addIssue({ code: "custom", message: "not applicable comparison must be empty" });
});

export const duelPressDetailReadoutSchema = z.object({
  id: z.string().regex(/^[a-z][A-Za-z0-9]*$/), label: z.string().min(1), value: finite.nullable(), unit: z.enum(["count", "per90", "goals", "percent", "score"]), direction: z.enum(["higher_is_better", "lower_is_better", "neutral"]), source: z.enum(["player_season_total", "league_per90_fallback", "tactical_ratio_static", "server_derived", "unavailable"]), state: z.enum(["observed", "server_derived", "imputed", "unavailable", "legacy_partial"]), comparison: comparisonSchema, formulaId: z.string().min(1).nullable(), formulaVersion: z.string().min(1).nullable(), missingComponents: z.array(z.string().min(1)).nullable(),
}).strict().superRefine((value, ctx) => {
  const formula = value.formulaId !== null && value.formulaVersion !== null;
  const missing = value.missingComponents !== null && value.missingComponents.length > 0;
  if ((value.formulaId === null) !== (value.formulaVersion === null)) ctx.addIssue({ code: "custom", message: "formula fields must occur together" });
  if (value.state === "imputed") { if (value.value === null || value.source !== "unavailable" || !missing || formula || value.comparison.state === "available") ctx.addIssue({ code: "custom", message: "imputed readout is inconsistent" }); return; }
  if (value.value === null) { if (!(["unavailable", "legacy_partial"] as readonly string[]).includes(value.state) || value.source !== "unavailable" || value.comparison.state === "available" || (value.state === "legacy_partial" && !missing)) ctx.addIssue({ code: "custom", message: "null readout is inconsistent" }); }
  else if (["unavailable", "legacy_partial"].includes(value.state) || value.source === "unavailable") ctx.addIssue({ code: "custom", message: "numeric readout cannot be unavailable" });
  if (value.source === "server_derived" && (value.state !== "server_derived" || !formula)) ctx.addIssue({ code: "custom", message: "derived provenance requires a formula" });
  if (["player_season_total", "tactical_ratio_static"].includes(value.source) && (value.state !== "observed" || formula)) ctx.addIssue({ code: "custom", message: "direct provenance must be observed" });
  if (value.source === "league_per90_fallback" && !((value.state === "observed" && !formula) || (value.state === "server_derived" && formula))) ctx.addIssue({ code: "custom", message: "fallback provenance is inconsistent" });
  if (value.source === "unavailable" && !["unavailable", "legacy_partial"].includes(value.state)) ctx.addIssue({ code: "custom", message: "unavailable provenance is inconsistent" });
  if (value.state === "server_derived" && !formula) ctx.addIssue({ code: "custom", message: "derived state requires formula" });
  if (formula && !["server_derived", "unavailable"].includes(value.state)) ctx.addIssue({ code: "custom", message: "formula is invalid for state" });
  if (missing && value.state !== "legacy_partial") ctx.addIssue({ code: "custom", message: "missing components are invalid for state" });
});

const categorySchema = z.object({ id: z.enum(categoryIds), label: z.string().min(1), score: finite.min(0).max(100).nullable(), scoreState: z.enum(["observed", "imputed", "unavailable"]), imputedComponents: z.array(z.string().min(1)), comparison: comparisonSchema, readouts: z.array(duelPressDetailReadoutSchema).min(1) }).strict().superRefine((value, ctx) => {
  if ((value.score === null) !== (value.scoreState === "unavailable")) ctx.addIssue({ code: "custom", message: "category score state is inconsistent" });
  if ((value.scoreState === "imputed") !== (value.imputedComponents.length > 0)) ctx.addIssue({ code: "custom", message: "category imputation is inconsistent" });
  if (value.readouts.map((item) => item.id).join("|") !== expectedReadouts[value.id].join("|")) ctx.addIssue({ code: "custom", message: "category readout ownership/order is invalid" });
  for (const item of value.readouts) { const direction = ["failedDribblesPer90", "groundLostPer90", "aerialLostPer90"].includes(item.id) ? "lower_is_better" : "higher_is_better"; if (item.direction !== direction) ctx.addIssue({ code: "custom", message: "category direction is invalid" }); }
  if (value.id === "forwardPress") for (const [totalId, per90Id] of [["recoveries", "recoveriesPer90"], ["finalThirdPossessionsWon", "finalThirdPossessionsWonPer90"]] as const) { const total = value.readouts.find((item) => item.id === totalId)!; const per90 = value.readouts.find((item) => item.id === per90Id)!; if ((total.value === null) !== (per90.value === null) || total.source !== per90.source) ctx.addIssue({ code: "custom", message: "press total/per90 pairing is invalid" }); if (total.source === "league_per90_fallback" && (total.state !== "server_derived" || total.formulaId !== "league-per90-total-v1" || per90.state !== "observed")) ctx.addIssue({ code: "custom", message: "fallback press pairing is invalid" }); }
});

const contextSchema = z.object({ playerId: z.number().int().positive().safe(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.enum(["league", "europe"]), scope: scope.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable() }).strict().superRefine((value, ctx) => { if (value.mode === "league" && (value.scope === null || value.competition !== null)) ctx.addIssue({ code: "custom", message: "league context must have scope only" }); if (value.mode === "europe" && (value.scope !== null || value.competition === null)) ctx.addIssue({ code: "custom", message: "Europe context must have competition only" }); });
const asset = z.object({ id: z.number().int(), name: z.string().min(1), icon: z.string().url() }).strict();

export const duelPressDetailReadoutEnvelopeSchema = z.object({ metricTaxonomyVersion: z.literal("duel-press-v1"), readoutVersion: z.literal("detail-readout-v1"), context: contextSchema, player: z.object({ id: z.number().int().positive().safe(), idNamespace: z.literal("fotmob"), name: z.string().min(1), position: z.string().min(1), club: asset, league: asset }).strict(), categories: z.array(categorySchema).length(6), contextIndicators: z.array(duelPressDetailReadoutSchema).length(2) }).strict().superRefine((value, ctx) => {
  if (value.context.playerId !== value.player.id || value.context.idNamespace !== value.player.idNamespace) ctx.addIssue({ code: "custom", message: "player identity must echo context" });
  if (value.categories.map((item) => item.id).join("|") !== categoryIds.join("|")) ctx.addIssue({ code: "custom", message: "category order is invalid" });
  if (value.contextIndicators.map((item) => item.id).join("|") !== indicatorIds.join("|")) ctx.addIssue({ code: "custom", message: "indicator order is invalid" });
  for (const [item, formula] of value.contextIndicators.map((item, index) => [item, ["net-progression-v1", "goals-minus-xgot-v1"][index]] as const)) if (item.direction !== "neutral" || item.formulaId !== formula) ctx.addIssue({ code: "custom", message: "indicator semantics are invalid" });
});

export type DuelPressDetailReadoutEnvelope = z.infer<typeof duelPressDetailReadoutEnvelopeSchema>;
export type DuelPressDetailReadout = z.infer<typeof duelPressDetailReadoutSchema>;
