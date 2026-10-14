import { describe, expect, test } from "bun:test";
import {
  changeSkill,
  isPresetSkill,
  saveSkill,
  testSkill,
} from "../../src/skills/catalog.ts";
import { workspace } from "../fixtures.ts";

describe("preset skill policy", () => {
  test("presets allow only enable/disable and preserve their published instructions", () => {
    const w = workspace();
    for (const skill of w.skills) {
      expect(skill.preset).toBe(true);
      expect(isPresetSkill(w, skill)).toBe(true);
      const published = structuredClone(skill.published);
      changeSkill(w, "101", skill.id, skill.version, "disable");
      expect(skill.enabled).toBe(false);
      changeSkill(w, "303", skill.id, skill.version, "enable");
      expect(skill.enabled).toBe(true);
      expect(skill.published).toEqual(published);
      const before = structuredClone(w);
      for (const action of ["publish", "rollback", "archive"] as const) {
        expect(() =>
          changeSkill(w, "101", skill.id, skill.version, action, 1),
        ).toThrow("preset_skill_read_only");
      }
      expect(() =>
        saveSkill(
          w,
          "101",
          { ...skill.draft, body: "Attempted edit." },
          skill.id,
          skill.version,
        ),
      ).toThrow("preset_skill_read_only");
      expect(() => testSkill(w, "101", skill.id, "sample")).toThrow(
        "preset_skill_read_only",
      );
      expect(w).toEqual(before);
    }
  });
  test("legacy presets are recognized without changing published versions or tool grants", () => {
    const w = workspace();
    for (const skill of w.skills) {
      delete skill.preset;
      skill.draft.tools = skill.draft.tools.filter(
        (tool) => tool !== "query_model_cost",
      );
      expect(isPresetSkill(w, skill)).toBe(true);
      expect(() =>
        saveSkill(
          w,
          "101",
          { ...skill.draft, name: "Changed name" },
          skill.id,
          skill.version,
        ),
      ).toThrow("preset_skill_read_only");
      const original = structuredClone(skill.published);
      changeSkill(w, "101", skill.id, skill.version, "disable");
      expect(w.skills.find((saved) => saved.id === skill.id)?.preset).toBe(
        true,
      );
      expect(skill.published).toEqual(original);
      expect(skill.draft.tools).not.toContain("query_model_cost");
    }
  });
  test("customized legacy seeds and new custom copies remain editable", () => {
    const w = workspace();
    const legacy = w.skills[0];
    if (!legacy) throw Error("Missing preset");
    delete legacy.preset;
    legacy.draft = {
      ...structuredClone(legacy.draft),
      body: "Previously customized instructions.",
    };
    expect(isPresetSkill(w, legacy)).toBe(false);
    const restored = legacy.published[0];
    if (!restored) throw Error("Missing original instructions");
    saveSkill(w, "101", restored, legacy.id, legacy.version);
    expect(w.skills.find((saved) => saved.id === legacy.id)?.preset).toBe(
      false,
    );
    expect(isPresetSkill(w, legacy)).toBe(false);
    changeSkill(w, "101", legacy.id, legacy.version, "publish");
    expect(legacy.published).toHaveLength(2);

    const original = workspace().skills[0];
    if (!original) throw Error("Missing preset");
    w.skills = [];
    const custom = saveSkill(w, "101", original.draft);
    expect(custom.preset).toBe(false);
    expect(isPresetSkill(w, custom)).toBe(false);
    changeSkill(w, "101", custom.id, custom.version, "publish");
    testSkill(w, "101", custom.id, "sample");
    changeSkill(w, "101", custom.id, custom.version, "rollback", 1);
    changeSkill(w, "101", custom.id, custom.version, "archive");
    expect(custom.archived).toBe(true);
  });
  test("preset toggles retain administration and optimistic revision checks", () => {
    const w = workspace();
    const skill = w.skills[0];
    if (!skill) throw Error("Missing preset");
    expect(() =>
      changeSkill(w, "202", skill.id, skill.version, "disable"),
    ).toThrow("access_denied");
    expect(() =>
      changeSkill(w, "999", skill.id, skill.version, "disable"),
    ).toThrow("access_denied");
    const revision = skill.version;
    changeSkill(w, "101", skill.id, revision, "disable");
    expect(() => changeSkill(w, "101", skill.id, revision, "enable")).toThrow(
      "version_conflict",
    );
    expect(skill.enabled).toBe(false);
  });
});
