export type PitchLayerVisibility = {
  heatmap: boolean;
  cca: boolean;
  trajectories: boolean;
  markers: boolean;
};

export const DEFAULT_PITCH_LAYERS: PitchLayerVisibility = {
  heatmap: true,
  cca: true,
  trajectories: true,
  markers: true,
};

export const PITCH_LAYER_LABELS: Readonly<Record<keyof PitchLayerVisibility, string>> = {
  heatmap: "히트맵",
  cca: "CCA",
  trajectories: "궤적",
  markers: "슈팅 마커",
};
