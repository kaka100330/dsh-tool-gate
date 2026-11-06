/**
 * Fold the pre-merge per-package prompt switches into their families.
 *
 * Version 1 of this plugin had two lists: one switch per family (collapse) and
 * one switch per package (prompt disclosure). A family and its package are the
 * same entity, so version 2 keeps one switch per family and stores the prompt
 * answer next to the collapse answer:
 *
 *   v1: promptPlugins: { "dsh-free-search": { enabled: true } }
 *   v2: families: { free_search: { promptDisclosure: true } }
 *
 * Reading `promptPlugins` forever would work, but it would mean two sources of
 * truth for one switch: turning the merged switch off would clear the family flag
 * while the legacy entry kept it on. So the migration rewrites the config once,
 * and afterwards only the family flag is consulted.
 *
 * It is idempotent — after the first run there is no `enabled: true` entry left to
 * move — and it never invents families: a package with no family has no gateway
 * to carry its prose, and v1 ignored those entries too (`shouldBlank` requires a
 * family). They are dropped with a debug line rather than kept as dead config
 * that looks like it does something.
 *
 * @param options.config - the live (volatile) config object.
 * @param options.families - the resolved family table; the package-to-family map
 *   comes from here, so it must be resolved before this runs.
 * @param options.logger - optional logger.
 * @returns `{ migrated, moved, dropped }` — what changed, for the test and log.
 */
export function migratePromptPlugins(options) {
  const { config, families, logger } = options;
  const result = { migrated: false, moved: [], dropped: [] };
  if (config === null || typeof config !== "object") return result;

  const legacy = readValue(config, "promptPlugins") ?? {};
  const enabledPackages = Object.entries(legacy)
    .filter(([, row]) => row?.enabled === true)
    .map(([pkg]) => pkg);
  if (enabledPackages.length === 0) return result;

  /** package -> family id, over the resolved table. */
  const familyOfPackage = new Map();
  for (const family of Object.values(families ?? {})) {
    for (const pkg of family?.packages ?? []) familyOfPackage.set(pkg, family.id);
  }

  /** family id -> family, for the ones that should now disclose. */
  const wanted = [];
  for (const pkg of enabledPackages) {
    const familyId = familyOfPackage.get(pkg);
    if (familyId === undefined) result.dropped.push(pkg);
    else if (!result.moved.includes(familyId)) {
      result.moved.push(familyId);
      wanted.push(familyId);
    }
  }

  // Write the family flags first. If a write fails, the legacy dict is still
  // intact, so the next startup retries from a consistent state instead of
  // leaving a half-migrated config.
  if (wanted.length > 0) {
    const table = readValue(config, "families") ?? {};
    const next = { ...table };
    for (const familyId of wanted) {
      next[familyId] = { ...(next[familyId] ?? {}), promptDisclosure: true };
    }
    if (!writeValue(config, "families", next)) {
      result.moved = [];
      result.migrated = false;
      return result;
    }
  }

  // Then clear the legacy switches. The key stays so an old profile still
  // validates, but every switch is off, which makes `prompt-scan.js`'s legacy
  // read path agree with the family flags from here on.
  const cleared = { ...legacy };
  for (const pkg of enabledPackages) cleared[pkg] = { ...(cleared[pkg] ?? {}), enabled: false };
  writeValue(config, "promptPlugins", cleared);

  result.migrated = result.moved.length > 0;
  if (result.dropped.length > 0) {
    logger?.debug?.(
      `dsh-tool-gate: prompt switches for ${result.dropped.join(", ")} have no family and were dropped `
        + "(a package with no gateway has nothing to disclose into)",
    );
  }
  if (result.migrated) {
    logger?.info?.(
      `dsh-tool-gate: moved prompt disclosure switches onto families ${result.moved.join(", ")}`,
    );
  }
  return result;
}

/**
 * Read one config field as a plain value.
 *
 * Volatile fields arrive as `{ get() }` references, not values, so reading the
 * dict the ordinary way yields the reference object instead of the map.
 */
function readValue(config, field) {
  const raw = config[field];
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw?.get === "function") {
    try {
      return raw.get();
    } catch {
      return undefined;
    }
  }
  return raw;
}

/**
 * Replace one volatile config field in place.
 *
 * The Loader exposes a write symbol on every volatile reference
 * (`Symbol.for("cosmokit.volatile.write")`), and that is the only supported way
 * to change a running config from inside the plugin. Returning `false` rather
 * than throwing matters: an old profile still behaves correctly through the
 * legacy read path, so failing to migrate is a downgrade in tidiness, not in
 * correctness.
 *
 * @returns whether the write happened.
 */
function writeValue(config, field, value) {
  const reference = config[field];
  if (reference === null || typeof reference !== "object") return false;
  const write = Object.getOwnPropertySymbols(reference)
    .find((symbol) => String(symbol).includes("cosmokit.volatile.write"));
  if (write === undefined || typeof reference[write] !== "function") return false;
  try {
    reference[write](value);
    return true;
  } catch {
    return false;
  }
}