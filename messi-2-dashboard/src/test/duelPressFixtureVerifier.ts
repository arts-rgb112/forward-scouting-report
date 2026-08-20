import validLeaderboard from "../../../docs/fixtures/duel_press_v1/valid_leaderboard.json";
import validDetail from "../../../docs/fixtures/duel_press_v1/valid_player_detail.json";
import nullRaw from "../../../docs/fixtures/duel_press_v1/null_raw_metrics.json";
import observedZero from "../../../docs/fixtures/duel_press_v1/observed_zero.json";
import sourceVariants from "../../../docs/fixtures/duel_press_v1/source_variants.json";
import invalidDiscriminator from "../../../docs/fixtures/duel_press_v1/invalid_discriminator.json";
import crossContext from "../../../docs/fixtures/duel_press_v1/cross_season_competition.json";
import { duelPressContextSchema, duelPressDetailCoreSchema, duelPressLeaderboardCoreSchema, pressingRawMetricsSchema } from "../api/duelPressContracts";
export function verifyCommittedDuelPressFixtures() { const files = [validLeaderboard, validDetail, nullRaw, observedZero, sourceVariants, invalidDiscriminator, crossContext]; const variants = Object.values(sourceVariants).every((value) => pressingRawMetricsSchema.safeParse(value).success); const contexts = [crossContext.left.expectedContext, crossContext.right.expectedContext].every((value) => duelPressContextSchema.safeParse(value).success); return { fileCount: files.length, valid: duelPressLeaderboardCoreSchema.safeParse(validLeaderboard).success && duelPressDetailCoreSchema.safeParse(validDetail).success && pressingRawMetricsSchema.safeParse(nullRaw).success && pressingRawMetricsSchema.safeParse(observedZero).success && variants && contexts && !duelPressDetailCoreSchema.safeParse(invalidDiscriminator).success }; }
