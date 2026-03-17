/**
 * Ensure Playwright browsers are installed.
 * On first call, tries to import playwright — if it fails with a browser-not-found
 * error, runs `bunx playwright install chromium` automatically, then retries.
 */

let installed = false

export async function ensurePlaywright(): Promise<typeof import("playwright")> {
  const pw = await import("playwright")

  if (installed) return pw

  // Quick check: try launching and closing a browser to verify installation
  try {
    const browser = await pw.chromium.launch({ headless: true })
    await browser.close()
    installed = true
    return pw
  } catch (err) {
    const msg = String(err)
    const needsInstall = msg.includes("Executable doesn't exist")
      || msg.includes("browserType.launch")
      || msg.includes("PLAYWRIGHT")
      || msg.includes("executable")

    if (!needsInstall) throw err

    console.log(`[playwright] browsers not installed, running: bunx playwright install chromium`)

    const proc = Bun.spawn(["bunx", "playwright", "install", "chromium"], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    const exitCode = await proc.exited

    if (exitCode !== 0) {
      console.error(`[playwright] install failed (exit ${exitCode}):`, stderr)
      throw new Error(`Playwright install failed: ${stderr.slice(0, 500)}`)
    }

    console.log(`[playwright] install complete`)
    if (stdout.trim()) console.log(stdout.trim())

    installed = true
    return pw
  }
}
