import type { DuelPressMetricKey } from "../api/duelPressTypes";

/**
 * Canonical public labels for duel-press axes where a screen has no
 * server-supplied label field to consume.
 */
export const duelPressAxisLabels: Readonly<Record<DuelPressMetricKey, string>> = {
  outsideShot: "박스 밖 슈팅",
  boxThreat: "박스 안 슈팅",
  dangerZone: "온볼 전개",
  combinedDuel: "통합 경합",
  spaceControl: "공간 점유",
  forwardPress: "전방 압박",
};

/**
 * Server-owned detail-readout-v2 keeps stable IDs while the UI owns Korean
 * presentation. Keep those labels here so player detail, radar, and future
 * readout surfaces cannot drift into separate translations.
 */
const duelPressV2GroupLabels: Readonly<Record<string, string>> = {
  outsideBoxShooting: "박스 밖 슈팅",
  inBoxShooting: "박스 안 슈팅",
  onBallDribbles: "온볼 전개",
  combinedDuelVolume: "통합 경합",
  groundDuels: "지상 경합",
  aerialDuels: "공중 경합",
  spaceControl: "공간 점유",
  forwardPressing: "전방 압박",
};

const duelPressV2MetricLabels: Readonly<Record<string, string>> = {
  outsideBoxShotAttempts: "박스 밖 슈팅 시도",
  outsideBoxXg: "박스 밖 xG",
  outsideBoxXgot: "박스 밖 xGOT",
  outsideBoxXgotMinusXg: "박스 밖 xGOT−xG",
  inBoxShotAttempts: "박스 안 슈팅 시도",
  inBoxXg: "박스 안 xG",
  inBoxXgot: "박스 안 xGOT",
  inBoxXgotMinusXg: "박스 안 xGOT−xG",
  dribbleAttempts: "드리블 시도",
  successfulDribbles: "성공 드리블",
  failedDribbles: "실패 드리블",
  netProgressionPer90: "순수 전진 기여도",
  combinedDuelAttempts: "통합 경합 시도",
  combinedDuelWins: "통합 경합 승리",
  combinedDuelLosses: "통합 경합 패배",
  combinedDuelWinRate: "통합 경합 승률",
  combinedDuelSuccessMarginPer90: "통합 경합 마진",
  groundDuelAttempts: "지상 경합 시도",
  groundDuelWins: "지상 경합 승리",
  groundDuelLosses: "지상 경합 패배",
  groundDuelWinRate: "지상 경합 승률",
  groundDuelSuccessMarginPer90: "지상 경합 마진",
  aerialDuelAttempts: "공중 경합 시도",
  aerialDuelWins: "공중 경합 승리",
  aerialDuelLosses: "공중 경합 패배",
  aerialDuelWinRate: "공중 경합 승률",
  aerialDuelSuccessMarginPer90: "공중 경합 마진",
  ccaAreaPct: "CCA 면적",
  dangerZoneDensity: "위험 지역 밀도",
  recoveries: "볼 회수",
  finalThirdPossessionsWon: "파이널 서드 탈취",
  goalsMinusXgot: "득점 운·상대 선방",
};

export function duelPressV2GroupLabel(id: string, serverLabel: string) {
  return duelPressV2GroupLabels[id] ?? serverLabel;
}

export function duelPressV2MetricLabel(id: string, serverLabel: string) {
  return duelPressV2MetricLabels[id] ?? serverLabel;
}
