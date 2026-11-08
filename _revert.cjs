const fs = require('fs');
const p = 'lib/index.js';
let text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
function sub(from, to, label) {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`${label}: ${parts.length - 1}`);
  text = parts.join(to);
}

sub(
  [
    '  /**',
    '   * Gateway names registered for the first time by the reconcile now in flight.',
    '   *',
    '   * On 0.2.2 the provider runs *before* this waterfall, so a gateway mounted in',
    '   * this pass cannot be in the list being assembled. Hiding its members now would',
    '   * leave the family unreachable until the next turn: the members are gone from',
    '   * the wire and the gateway that reaches them is not there yet. Their collapse is',
    '   * therefore deferred by exactly one assembly (see `handleProviderOwnedAssemble`).',
    '   */',
    '  let freshlyMounted = new Set();',
    '',
    '  /** Gateway names present at the end of the previous reconcile. */',
  ].join('\n'),
  '  /** Gateway names present at the end of the previous reconcile. */',
  'drop freshlyMounted field',
);

sub(
  '      gatewayNames = [];\n      freshlyMounted = new Set();\n      unfreezeIfWithdrawn(gatewayNames);',
  '      gatewayNames = [];\n      unfreezeIfWithdrawn(gatewayNames);',
  'drop disabled clear',
);

sub(
  '    const before = new Set(gatewayNames);\n    gatewayNames = reconcileGateways({',
  '    gatewayNames = reconcileGateways({',
  'drop before',
);

sub(
  '    freshlyMounted = new Set(gatewayNames.filter((name) => !before.has(name)));\n    unfreezeIfWithdrawn(gatewayNames);',
  '    unfreezeIfWithdrawn(gatewayNames);',
  'drop freshlyMounted assign',
);

sub(
  [
    '    // A family whose gateway was mounted on THIS pass has to stay visible for one',
    '    // more assembly: the provider already ran, so the gateway is not on the wire',
    '    // yet. Collapsing now would strand the family for a turn.',
    '    const deferred = source.filter((schema) => {',
    '      const familyId = resolver.familyOf(schema?.name);',
    '      return familyId !== undefined && freshlyMounted.has(gatewayNameFor(familyId));',
    '    });',
    '    const collapsible = deferred.length === 0',
    '      ? source',
    '      : source.filter((schema) => !deferred.includes(schema));',
    '',
    '    // A surface frozen while a family was deferred is not final: the whole point of',
    '    // the deferral is that it expires on the next assembly. Rebuilding then is what',
    '    // actually hides the members, so the freeze is only sticky once nothing is',
    '    // pending.',
    '    const frozen = state.frozen;',
    '    if (frozen === undefined || live.freeze === false || (state.deferredCollapse ?? 0) > 0) {',
  ].join('\n'),
  [
    '    const frozen = state.frozen;',
    '    if (frozen === undefined || live.freeze === false) {',
  ].join('\n'),
  'drop deferral block',
);

sub(
  [
    '      const built = buildFrozenSurface(collapsible, {',
  ].join('\n'),
  '      const built = buildFrozenSurface(source, {',
  'back to source',
);

sub(
  [
    '      state.adopt(built.tools, built.collapsed);',
    '      state.deferredCollapse = deferred.length;',
  ].join('\n'),
  '      state.adopt(built.tools, built.collapsed);',
  'drop deferredCollapse',
);

sub(
  [
    '        `dsh-tool-gate: hiding ${built.collapsed.length} of ${source.length} tool(s) at the provider`',
    '          + (deferred.length > 0 ? `, deferring ${deferred.length} until its gateway is on the wire` : "")',
    '          + ` (agent ${state.id || "?"})`,',
  ].join('\n'),
  [
    '        `dsh-tool-gate: hiding ${built.collapsed.length} of ${source.length} tool(s) at the provider`',
    '          + ` (agent ${state.id || "?"})`,',
  ].join('\n'),
  'drop log suffix',
);

fs.writeFileSync(p, text);
console.log('deferral removed');
