// Shared by each engine's test file: `pinRoleMaps` pins what an engine promises for its `models` and `efforts` args,
// and `pinWriteNotes` pins the relaunch notes in each prompt that writes a file.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const EFFORT_CYCLE = ['low', 'medium', 'xhigh', 'max'];
const LEGAL = {
  models: { good: 'opus', bad: 'gpt', set: 'opus | sonnet | haiku | fable' },
  efforts: { good: 'high', bad: 'ultra', set: 'low | medium | high | xhigh | max' },
};

/**
 * A role's agents carry the role's effort, an unset effort passes high, a launch line names every role,
 * and each bad shape, key or value throws before any agent runs.
 * @param {object} spec
 * @param {string} spec.engine    engine path
 * @param {string} spec.name      the launch line's prefix, such as 'refine'
 * @param {object} spec.defaults  role key to its default model, in the engine's role-key order
 * @param {Array<{args:object, respond:object, labels:object}>} spec.runs  runs that together spawn every role.
 *        `labels` maps a role key to the label prefix of its agents in that run.
 */
export async function pinRoleMaps({ engine, name, defaults, runs }) {
  const keys = Object.keys(defaults);
  const roles = keys.join(' | ');
  const jsonArgs = (arg, mapJson) => JSON.parse(`${JSON.stringify(runs[0].args).slice(0, -1)},"${arg}":${mapJson}}`);
  const launchLine = (models, efforts) => `${name}: roles ${keys.map((k) => `${k}=${models[k]}/${efforts[k]}`).join(', ')}`;

  // Each role's agents, over every run: the set of values the opts carried for it.
  const optsByRole = async (extra) => {
    const seen = Object.fromEntries(keys.map((k) => [k, { model: new Set(), effort: new Set() }]));
    const lines = [];
    for (const run of runs) {
      const { calls, logs } = await runEngine(engine, { args: { ...run.args, ...extra }, respond: run.respond });
      lines.push(...logs);
      for (const [key, label] of Object.entries(run.labels)) {
        for (const call of calls.filter((c) => c.label.startsWith(label))) {
          seen[key].model.add(call.opts.model);
          seen[key].effort.add(call.opts.effort);
        }
      }
    }
    return { seen, lines };
  };
  const valuesOf = (seen) => keys.map((k) => `${k}=${[...seen[k].model].join(',')}/${[...seen[k].effort].join(',')}`).join(' ');

  section(`${name}: an unset effort passes high, and a set effort or model reaches only its own role`);
  {
    const unset = await optsByRole({});
    const highs = Object.fromEntries(keys.map((k) => [k, 'high']));
    eq(valuesOf(unset.seen), keys.map((k) => `${k}=${defaults[k]}/high`).join(' '), 'no maps: every role passes its default model and high');
    ok(unset.lines.includes(launchLine(defaults, highs)), `the launch line names every role: ${unset.lines.find((l) => l.startsWith(`${name}: roles`))}`);

    const efforts = Object.fromEntries(keys.map((k, i) => [k, EFFORT_CYCLE[i % EFFORT_CYCLE.length]]));
    const models = { [keys[0]]: 'haiku' };
    const set = await optsByRole({ models, efforts });
    eq(valuesOf(set.seen), keys.map((k) => `${k}=${models[k] ?? defaults[k]}/${efforts[k]}`).join(' '), 'each role\'s efforts level reaches its own agents, and models.' + keys[0] + ' reaches only its own');
    ok(set.lines.includes(launchLine({ ...defaults, ...models }, efforts)), 'the launch line names each role\'s set model and effort');

    const partial = await optsByRole({ efforts: { [keys[0]]: 'max' } });
    eq(valuesOf(partial.seen), keys.map((k) => `${k}=${defaults[k]}/${k === keys[0] ? 'max' : 'high'}`).join(' '), 'a role the efforts map leaves out still passes high');
  }

  section(`${name}: models and efforts throw at launch on a bad shape, key or value`);
  // JSON.parse makes __proto__ an own key, which an object literal would turn into a prototype instead.
  for (const arg of ['models', 'efforts']) {
    const { good, bad, set } = LEGAL[arg];
    for (const [shape, mapJson] of [['an array', '["x"]'], ['null', 'null'], ['a string', '"high"']]) {
      const msg = await throwsWith(engine, { args: jsonArgs(arg, mapJson), respond: {} });
      ok(msg.startsWith(`Invalid role map: args.${arg} must be an object`), `${arg} as ${shape} throws naming the arg: ${msg.slice(0, 70)}`);
    }
    for (const key of ['planner', 'constructor', 'toString', '__proto__']) {
      const msg = await throwsWith(engine, { args: jsonArgs(arg, `{"${key}":"${good}"}`), respond: {} });
      ok(msg.includes(`args.${arg} names "${key}"`) && msg.includes(roles), `${arg} key ${key} throws and lists the role keys: ${msg.slice(0, 90)}`);
    }
    const value = await throwsWith(engine, { args: { ...runs[0].args, [arg]: { [keys[0]]: bad } }, respond: {} });
    ok(value.includes(`args.${arg}.${keys[0]} is "${bad}"`) && value.includes(set), `${arg} value ${bad} throws naming the role, the value and the legal set: ${value.slice(0, 90)}`);
    const inherited = await throwsWith(engine, { args: { ...runs[0].args, [arg]: { [keys[0]]: 'constructor' } }, respond: {} });
    ok(inherited.includes(`args.${arg}.${keys[0]} is "constructor"`), `a value named like an inherited member throws: ${inherited.slice(0, 70)}`);
  }
}

const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';

const FILE_WRITE_NOTE = 'Write file content with the file-editing tool, since a shell heredoc can alter backslashes and backticks.';

/**
 * Pins the heredoc warning at each write site, which is each place a prompt carries the rejected-write note
 * unless a row's fifth value gives the warning's own count, as for a prompt that embeds another agent's text.
 * @param {Array<[string, string, number, number, number?]>} sites  the rows given to pinWriteNotes
 */
export function pinFileWriteNote(sites) {
  const times = (text, needle) => text.split(needle).length - 1;
  for (const [where, text, , wrotes, fileWrites = wrotes] of sites) {
    eq(times(text, FILE_WRITE_NOTE), fileWrites, `${where}: the prompt tells the agent to write file content with the file-editing tool`);
  }
}

/**
 * Pins the two relaunch notes in each prompt that writes a file.
 * @param {Array<[string, string, number, number]>} sites  [where, prompt text, REPLACE_NOTE count, WROTE_NOTE count]
 */
export function pinWriteNotes(sites) {
  const times = (text, needle) => text.split(needle).length - 1;
  for (const [where, text, replaces, wrotes] of sites) {
    eq(times(text, REPLACE_NOTE), replaces, `${where}: the prompt carries the Read-first note at each write site`);
    eq(times(text, WROTE_NOTE), wrotes, `${where}: the prompt carries the rejected-write note`);
  }
}
