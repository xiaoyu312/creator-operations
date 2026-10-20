/** User-facing simulated workspace built on 来源品牌 source basics. Historical 来源品牌 is a different brand. */
export const SOURCE_SCENARIO_BRAND_NAME = "来源品牌 场景演示";

const PREVIEW_NAME_MARKERS = ["模拟数据", "合成演示", "预览数据"] as const;

export function isSourceScenarioDemoBrand(brand: { name: string } | null | undefined): boolean {
  return brand?.name.trim() === SOURCE_SCENARIO_BRAND_NAME;
}

/** Synthetic business brands such as 云眠生活（模拟数据 DEMO）. Historical 来源品牌 is not one of these. */
export function isPreviewBusinessBrand(brand: { name: string } | null | undefined): boolean {
  const name = brand?.name.normalize("NFKC").trim().replace(/\s+/gu, " ") ?? "";
  if (!name) return false;
  if (PREVIEW_NAME_MARKERS.some((marker) => name.includes(marker))) return true;
  if (name === "云眠生活" || name.startsWith("云眠生活 ") || name.startsWith("云眠生活(")) return true;
  if (/(?:^|[\s(])DEMO(?:$|[\s)])/iu.test(name)) return true;
  if (name.toLocaleUpperCase("en-US").includes("SYNTHETIC")) return true;
  return false;
}

/** Brands that stay in storage but must not be opened, listed, or restored. */
export function isUnavailableDemoBrand(brand: { name: string } | null | undefined): boolean {
  return isSourceScenarioDemoBrand(brand) || isPreviewBusinessBrand(brand);
}

export function isSourceScenarioWorkspace(info: { kind?: string } | null | undefined): boolean {
  return info?.kind === "source_scenario";
}
