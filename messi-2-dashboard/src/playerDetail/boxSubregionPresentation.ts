import { BOX_SUBREGION_ORDER } from "../api/boxSubregionContracts";

/**
 * Display copy intentionally differs from the immutable server taxonomy:
 * `L3L`/`L3R` remain the server IDs and original bounds, while the product
 * uses the owner-approved left-to-right wording in Korean.
 */
export const BOX_SUBREGION_PRESENTATION_LABEL: Record<(typeof BOX_SUBREGION_ORDER)[number], string> = {
  L4: "박스 좌",
  L3L: "박스 좌중",
  L3R: "박스 우중",
  L2: "박스 우",
};

export const boxSubregionPresentationLabel = (id: (typeof BOX_SUBREGION_ORDER)[number]) => BOX_SUBREGION_PRESENTATION_LABEL[id];
