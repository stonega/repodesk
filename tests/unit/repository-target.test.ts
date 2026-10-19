import { expect, test } from "bun:test";
import { requireRepositoryTarget } from "../../src/coding/repository-target.ts";
import { workspace } from "../fixtures.ts";

function fixture() {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 1,
    repositories: [
      { id: 1, full_name: "acme/product", default_branch: "main" },
      { id: 2, full_name: "acme/product-landing", default_branch: "main" },
    ],
  };
  return w;
}
const original =
  "Add a /docs route to product-land using the original documents from https://github.com/acme/product/blob/main/docs/README.md";

test("a quoted modification target and its unique abbreviation cannot select the documentation repository", () => {
  const w = fixture();
  expect(() =>
    requireRepositoryTarget(w, 2, [original], "product-land"),
  ).not.toThrow();
  expect(() =>
    requireRepositoryTarget(w, 1, [original], "product-land"),
  ).toThrow("coding_repository_target_mismatch");
  expect(() => requireRepositoryTarget(w, 1, [original], "product")).toThrow(
    "coding_repository_target_unverified",
  );
  expect(() =>
    requireRepositoryTarget(w, 2, [original], "acme/product-landing"),
  ).toThrow("coding_repository_target_unverified");
});

test("literal target evidence supports Chinese, case, full names and bare repo URLs without matching document URL substrings", () => {
  const w = fixture();
  for (const text of [
    "修改 acme/product-landing，文档来自 product",
    "修改 `ACME/PRODUCT-LANDING`",
    "修改 https://github.com/acme/product-landing",
    "修改 https://github.com/acme/product-landing.git",
  ])
    expect(() =>
      requireRepositoryTarget(w, 2, [text], "acme/product-landing"),
    ).not.toThrow();
  expect(() =>
    requireRepositoryTarget(w, 2, ["product-landing-extra"], "product-landing"),
  ).toThrow("coding_repository_target_unverified");
  expect(() =>
    requireRepositoryTarget(
      w,
      2,
      ["看 https://github.com/acme/product-landing/issues/5"],
      "acme/product-landing",
    ),
  ).toThrow("coding_repository_target_unverified");
  expect(() =>
    requireRepositoryTarget(w, 2, ["Also fix pagination"], ""),
  ).not.toThrow();
});

test("ambiguous abbreviations do not guess between connected repositories", () => {
  const w = fixture();
  w.github?.repositories.push({
    id: 3,
    full_name: "acme/product-landmark",
    default_branch: "main",
  });
  expect(() =>
    requireRepositoryTarget(w, 2, [original], "product-land"),
  ).toThrow("coding_repository_target_ambiguous");
});
