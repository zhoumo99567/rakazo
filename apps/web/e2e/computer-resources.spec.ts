import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("changes team computer limits and preserves them when the dialog reopens", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/computer-resources.html");
  await expect(page.getByLabel("CPU cores")).toHaveValue("2");
  await expect(page.getByText("Applies to every bot using this team computer.")).toBeVisible();
  await page.getByLabel("CPU cores").fill("4");
  await page.getByLabel("Memory (MiB)").fill("8192");
  await captureScreenshot(page, testInfo, "team-computer-resource-limits");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Saved limits")).toContainText('"memoryMiB":8192');
  await page.getByRole("button", { name: "Open resource settings" }).click();
  await expect(page.getByLabel("CPU cores")).toHaveValue("4");
  await expect(page.getByLabel("Memory (MiB)")).toHaveValue("8192");
});

test("warns before decreasing private computer memory and rejects invalid values", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/computer-resources.html?private");
  await expect(page.getByLabel("Memory (MiB)")).toHaveValue("2048");
  await expect(page.getByText("Applies to every bot using this team computer.")).toBeHidden();
  await page.getByLabel("Memory (MiB)").fill("1024");
  await expect(
    page.getByText("Lowering memory can terminate programs. Save your work first."),
  ).toBeVisible();
  await page.getByLabel("CPU cores").fill("-1");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});
