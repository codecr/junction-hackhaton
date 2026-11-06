#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { charterTopicSchema, formatInstant, type SquadView } from '@junction/core';
import { EVENT_ID, Junction } from './app';
import { catalogStats } from './catalog-store';
import { ApiError } from './events-client';
import { junctionHome } from './paths';
import {
  approveFromServer,
  attachRelay,
  DEFAULT_SQUAD_SERVER,
  inviteCode,
  joinThroughServer,
  pendingRequests,
  publishCharter,
  relayClient,
} from './relay';
import { startUiServer } from './server';
import {
  createSquad,
  ensureIdentity,
  exportJoinBlock,
  exportPicksBlock,
  importBlock,
  loadCharter,
  loadLocal,
  saveLocal,
  updateCharter,
} from './squad';

// `junction <command>`. Output is plain text for people; `--json` where noted for scripts.

const HELP = `Junction: cover re:Invent as a team without sharing accounts.

Usage: junction <command> [options]

  login                      Sign in with AWS Builder ID (opens your browser)
  logout                     Revoke and delete your tokens
  whoami [--name <name>]     Show or set your display name and member id
  doctor                     Check sign-in, catalog, squad and ports

  catalog refresh            Download the catalog (paginates ListSessions)
  catalog stats              Fields, venues, labels and code patterns in your catalog
  session <code|id>          Details of one session (GetSession, fetched live)

  squad create <name> [--topics file.json] [--must CODE,CODE] [--lunch 12:00-13:00]
  squad server [url]         Use the squad server (default ${DEFAULT_SQUAD_SERVER}) instead of pasting
  squad invite               Print the invite (a code for the squad server, or a block to paste)
  squad join <code|secret>   Join through the squad server with an invite code, or print a join block
  squad requests             Leader: pending join requests on the squad server
  squad approve <id|block>   Leader: add the member to the squad rules
  squad export [--out file]  Print or save your squad block (rules plus every member's picks)
  squad import <block|file>  Import a block from a squad member
  squad share <L0|L1|L2>     Choose what you share (L0: session ids and codes only)

  sync                       Read your schedule, sign your picks, recompute the squad view
  status                     Coverage, issues and proposals for the squad
  proposals                  Proposals for you, with ids
  accept <id> [--reserve]    Apply a proposal to your own schedule (favorites, or reserve)
  decline <id>               Decline a proposal (no agent proposes it again for 24 h)
  undo <id>                  Undo a proposal you accepted

  meet add "<label>" --date 2026-12-01 --start 12:30 --end 13:15 [--at "Venetian"]
  meet list | meet move <id> ... | meet delete <id>
                             Squad meeting points as personal time (Junction only touches its own)

  ui                         Open the squad view at http://127.0.0.1:4848

Your tokens and catalog stay in ${junctionHome()}.`;

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', `"${url}"`] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).unref();
  } catch {
    // The URL is also printed.
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const nowIso = () => formatInstant(Math.floor(Date.now() / 1000));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function nameOf(view: SquadView, memberId: string): string {
  return view.members.find((m) => m.memberId === memberId)?.name ?? memberId;
}

function describeProposal(view: SquadView, p: SquadView['proposals'][number]): string {
  const code = (id: string) => {
    const s = view.sessions[id];
    if (!s) return id;
    const day = view.days.find((d) => d.day === s.day);
    return `${s.code} (${day ? DAYS[day.weekday] : ''} ${hhmm(s.startLocal)}, ${view.venues.find((v) => v.id === s.venue)?.name ?? s.venue})`;
  };
  const who = nameOf(view, p.memberId);
  const adds = (p.add ?? []).map(code).join(', ');
  const removes = (p.remove ?? []).map(code).join(', ');
  const verb =
    p.kind === 'SWAP'
      ? `${who}: move from ${removes} to ${adds}`
      : p.kind === 'CLAIM'
        ? `${who}: take ${adds}`
        : p.kind === 'DROP'
          ? `${who}: release ${removes}`
          : `${who}: meet`;
  const why = p.reasons.join(', ');
  const diff = p.differences?.length ? `; differs in ${p.differences.join(', ')}` : '';
  return `${p.id.slice(0, 10)}  ${verb}\n            squad +${p.squadDelta}, you ${p.personalDelta >= 0 ? '+' : ''}${p.personalDelta}; ${why}${diff}${p.provisional ? '; provisional, catalogs differ' : ''}`;
}

function printStatus(view: SquadView): void {
  console.log(
    `${view.squadName}: ${view.members.length} members, ${view.members.filter((m) => m.hasPicks).length} with picks.`,
  );
  if (view.provisional)
    console.log("Proposals are provisional: one member's catalog is one update behind.");
  for (const d of view.days)
    console.log(`  ${DAYS[d.weekday]} ${d.d}: ${d.issues} issue${d.issues === 1 ? '' : 's'}`);
  const under = view.coverage.cells.filter((c) => c.state !== 'ok' && c.offered > 0);
  if (under.length) {
    console.log('Coverage below target:');
    for (const c of under) {
      const t = view.topics.find((x) => x.id === c.topicId);
      const day = view.days.find((d) => d.day === c.day);
      console.log(
        `  ${t?.label ?? c.topicId} on ${day ? `${DAYS[day.weekday]} ${day.d}` : c.day}: ${c.count} of ${c.target}`,
      );
    }
  }
  for (const d of view.coverage.duplicates.filter((x) => !x.planned))
    console.log(
      `Duplicate: ${d.code} held by ${d.attendees.map((a) => nameOf(view, a)).join(' and ')}`,
    );
  for (const h of view.coverage.hops) {
    const to = view.sessions[h.toSessionId]?.code ?? h.toSessionId;
    console.log(
      h.overlap
        ? `Overlap: ${nameOf(view, h.memberId)} holds ${to} while another session runs (${-h.haveMin} min)`
        : `Can't make the walk: ${nameOf(view, h.memberId)} to ${to} needs ${h.needMin} min, has ${h.haveMin}`,
    );
  }
  for (const g of view.coverage.gaps)
    console.log(
      `Nobody covers ${g.code ?? g.sessionId}${g.collidesWithLunch ? ' (during squad lunch)' : ''}`,
    );
  console.log(
    `${view.proposals.length} proposal${view.proposals.length === 1 ? '' : 's'} for the squad. Run \`junction proposals\`.`,
  );
}

async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  const args = [sub ?? '', ...rest].filter((a) => a !== '');
  const app = new Junction({ openBrowser });
  attachRelay(app);

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    case 'login':
      await app.login((url, port) =>
        console.log(
          `Opening your browser to sign in (callback on port ${port}).\nIf it does not open, visit:\n${url}`,
        ),
      );
      console.log('Signed in. Your tokens are stored only on this computer.');
      return;

    case 'logout': {
      const { revoked } = await app.logout();
      console.log(
        revoked
          ? 'Signed out and revoked your refresh token.'
          : 'Signed out. Tokens deleted (the revoke call did not confirm).',
      );
      console.log(
        'To also end your AWS Builder ID session in the browser, visit https://profile.aws.amazon.com and sign out there.',
      );
      return;
    }

    case 'whoami': {
      const me = ensureIdentity(flag(args, 'name'));
      console.log(`${me.name} (${me.memberId})`);
      return;
    }

    case 'doctor': {
      const me = ensureIdentity();
      const meta = app.store.meta();
      const charter = loadCharter();
      console.log(`Member: ${me.name} (${me.memberId})`);
      console.log(`Signed in: ${app.tokens.signedIn() ? 'yes' : 'no. Run `junction login`'}`);
      console.log(
        `Catalog: ${meta ? `${app.store.allRaw().length} sessions, fetched ${meta.fetchedAt}, timezone ${meta.timezone} (UTC${meta.utcOffsetMin / 60})` : 'none yet. Run `junction catalog refresh`'}`,
      );
      console.log(
        `Squad: ${charter ? `${charter.name}, ${charter.members.length} members, rules v${charter.seq}` : 'none. Run `junction squad create`'}`,
      );
      console.log(`Sharing level: ${loadLocal().share}`);
      const events = await app.api.listEvents().catch(() => []);
      console.log(
        `Events API reachable: ${events.length ? `yes (${events.some((e) => e.eventId === EVENT_ID) ? 'reinvent2026 listed' : 'reinvent2026 missing'})` : 'no'}`,
      );
      return;
    }

    case 'catalog': {
      if (sub === 'refresh') {
        const r = await app.refreshCatalog((n, total) =>
          process.stdout.write(`\r${n}${total ? ` of ${total}` : ''} sessions`),
        );
        console.log(
          `\nCatalog saved: ${r.count} sessions in ${r.pages} pages (totalCount ${r.totalCount ?? 'not reported'}).`,
        );
        if (r.diff.added.length || r.diff.removed.length || r.diff.changed.length)
          console.log(
            `Since last time: ${r.diff.added.length} added, ${r.diff.removed.length} removed, ${r.diff.changed.length} changed.`,
          );
        return;
      }
      if (sub === 'stats') {
        const snap = app.store.snapshot(app.venueGraph());
        if (!snap) throw new Error('No catalog yet. Run `junction catalog refresh`.');
        const stats = catalogStats(app.store.allRaw(), snap.snapshot.sessions, snap.skipped);
        if (args.includes('--json')) console.log(JSON.stringify(stats, null, 2));
        else {
          console.log(
            `${stats.total} sessions, ${stats.usable} placed on the chart, skipped: ${stats.skipped.map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
          );
          console.log(`Venues: ${stats.venues.map(([k, v]) => `${k} (${v})`).join('; ')}`);
          console.log(`Code suffixes: ${stats.suffixes.map(([k, v]) => `${k} ${v}`).join(', ')}`);
          console.log(`Topics: ${stats.topics.map(([k, v]) => `${k} (${v})`).join('; ')}`);
          console.log('Use --json for every field.');
        }
        return;
      }
      throw new Error('Use `junction catalog refresh` or `junction catalog stats`.');
    }

    case 'session': {
      if (!sub)
        throw new Error('Give a session code or id, for example `junction session OPS305-R`.');
      const raw = app.store.allRaw().find((r) => r.abbreviation === sub || r.sessionId === sub);
      const id = typeof raw?.sessionId === 'string' ? raw.sessionId : sub;
      const s = await app.api.getSession(EVENT_ID, id);
      const t = s.sessionTime as { date?: string; time?: string; length?: string } | undefined;
      console.log(`${String(s.abbreviation ?? '')} ${String(s.title ?? '')}`);
      console.log(
        `${t?.date ?? ''} ${t?.time ?? ''} (${t?.length ?? '?'} min), ${String(s.venue ?? '')}, ${String(s.room ?? '')}`,
      );
      if (s.seatAvailability) console.log(`Seats: ${String(s.seatAvailability)}`);
      if (typeof s.abstract === 'string') console.log(`\n${s.abstract}`);
      return;
    }

    case 'squad': {
      const me = ensureIdentity();
      if (sub === 'create') {
        const name = rest
          .filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'))
          .join(' ')
          .trim();
        if (!name)
          throw new Error('Give the squad a name: `junction squad create "Costa Rica builders"`.');
        const topicsFile = flag(rest, 'topics');
        const topics = topicsFile
          ? z.array(charterTopicSchema).parse(JSON.parse(readFileSync(topicsFile, 'utf8')))
          : [];
        const must =
          flag(rest, 'must')
            ?.split(',')
            .map((c) => c.trim())
            .filter(Boolean) ?? [];
        const raws = app.store.allRaw();
        const mustIds = must.map((c) => {
          const r = raws.find((x) => x.abbreviation === c || x.sessionId === c);
          if (!r)
            throw new Error(
              `Session ${c} is not in your catalog. Run \`junction catalog refresh\` first.`,
            );
          return String(r.sessionId);
        });
        const lunchFlag = flag(rest, 'lunch');
        const lunch = lunchFlag ? /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(lunchFlag) : null;
        const { charter, invite } = createSquad(me, {
          name,
          eventId: EVENT_ID,
          topics,
          mustCover: mustIds,
          ...(lunch ? { lunch: { start: lunch[1]!, end: lunch[2]!, protected: true } } : {}),
          now: nowIso(),
          expiresAt: '2026-12-18T00:00:00Z',
        });
        console.log(`Squad "${charter.name}" created (${charter.squadId}).`);
        console.log(`Invite secret, share it privately: ${invite}`);
        console.log('Members run `junction squad join <secret>` and send you the block it prints.');
        return;
      }
      if (sub === 'server') {
        const url = rest[0] ?? DEFAULT_SQUAD_SERVER;
        const client = relayClient(url)!;
        if (!(await client.health()))
          throw new Error(
            `The squad server at ${url} did not answer. Check the URL, or keep exchanging blocks.`,
          );
        saveLocal({ ...loadLocal(), relayUrl: url });
        const charter = loadCharter();
        if (charter?.leader === me.memberId) {
          await publishCharter(client);
          console.log(
            `Squad "${charter.name}" is on the squad server. Invite code: ${inviteCode()}`,
          );
        } else console.log(`Using the squad server at ${url}.`);
        return;
      }
      if (sub === 'requests') {
        const client = relayClient();
        if (!client) throw new Error('No squad server configured. Run `junction squad server`.');
        const reqs = await pendingRequests(client);
        if (!reqs.length) console.log('No pending join requests.');
        for (const r of reqs) console.log(`${r.memberId}  ${r.name}  (asked ${r.requestedAt})`);
        return;
      }
      if (sub === 'invite') {
        const local = loadLocal();
        if (local.relayUrl && local.inviteSecret) {
          console.log(`Invite code, share it privately:
  junction squad join ${inviteCode()}`);
          return;
        }
        if (!local.inviteSecret)
          throw new Error('Only the leader who created the squad has the invite secret.');
        console.log(
          `Invite secret: ${local.inviteSecret}\nSquad block (send it along):\n${exportPicksBlock()}`,
        );
        return;
      }
      if (sub === 'join' && rest[0]?.startsWith('sq_')) {
        const server = flag(rest, 'server') ?? DEFAULT_SQUAD_SERVER;
        const r = await joinThroughServer(rest[0], server);
        console.log(
          r.status === 'member'
            ? 'You are already a member. Run `junction sync`.'
            : 'Join request sent. When the leader approves it, run `junction sync`.',
        );
        return;
      }
      if (sub === 'join') {
        console.log('Send this join block to your squad leader:\n');
        console.log(exportJoinBlock(me, rest[0]));
        return;
      }
      if (sub === 'approve' && rest[0]?.startsWith('m_')) {
        const client = relayClient();
        if (!client) throw new Error('No squad server configured. Paste their join block instead.');
        const who = await approveFromServer(client, rest[0], nowIso());
        console.log(`${who} added to the squad rules and published to the squad server.`);
        return;
      }
      if (sub === 'approve') {
        const block = rest[0] ?? '';
        const r = importBlock(block.startsWith('junction1:') ? block : readFileSync(block, 'utf8'));
        if (!r.joinRequest) throw new Error('That is not a join block.');
        if (r.joinRequest.secretOk === false)
          throw new Error(
            'The invite secret in that join block is wrong. Ask them to use the current one.',
          );
        const jr = r.joinRequest;
        updateCharter(
          me,
          (c) => ({
            ...c,
            members: c.members.some((m) => m.memberId === jr.memberId)
              ? c.members
              : [
                  ...c.members,
                  {
                    memberId: jr.memberId,
                    name: jr.name,
                    publicKey: jr.publicKey,
                    role: 'member',
                    joinedAt: nowIso(),
                  },
                ],
          }),
          nowIso(),
        );
        console.log(
          `${jr.name} (${jr.memberId}) added. Send them this squad block:\n\n${exportPicksBlock()}`,
        );
        return;
      }
      if (sub === 'export') {
        const text = exportPicksBlock();
        const out = flag(rest, 'out');
        if (out) {
          writeFileSync(out, `${text}\n`);
          console.log(
            `Saved to ${out}. It holds session ids and codes only, signed by each member.`,
          );
        } else console.log(text);
        return;
      }
      if (sub === 'import') {
        const input = rest[0] ?? '';
        const text = input.startsWith('junction1:') ? input : readFileSync(input, 'utf8');
        const r = importBlock(text);
        if (r.joinRequest) {
          console.log(
            `This is a join request from ${r.joinRequest.name}. Run \`junction squad approve <block>\` to add them.`,
          );
          return;
        }
        console.log(
          `${r.charterUpdated ? 'Squad rules updated. ' : ''}${r.manifestsAccepted} member pick${r.manifestsAccepted === 1 ? '' : 's'} imported.`,
        );
        for (const why of r.rejected) console.log(`Rejected: ${why}`);
        return;
      }
      if (sub === 'share') {
        const level = rest[0];
        if (level !== 'L0' && level !== 'L1' && level !== 'L2')
          throw new Error(
            'Use L0 (ids and codes), L1 (plus busy blocks) or L2 (plus current venue).',
          );
        saveLocal({ ...loadLocal(), share: level });
        console.log(`Sharing level set to ${level}. It applies from your next sync.`);
        return;
      }
      throw new Error('Unknown squad command. Run `junction help`.');
    }

    case 'sync': {
      const state = await app.sync({ refreshCatalog: args.includes('--catalog') });
      if (app.lastRelayError)
        console.log(
          `Squad server: ${app.lastRelayError} Your own schedule synced; exchange blocks meanwhile.`,
        );
      if (state.squad) printStatus(state.squad);
      return;
    }

    case 'status': {
      const view = app.view();
      if (!view)
        throw new Error('No squad view yet. Create or join a squad, then run `junction sync`.');
      if (args.includes('--json')) console.log(JSON.stringify(view, null, 2));
      else printStatus(view);
      return;
    }

    case 'proposals': {
      const view = app.view();
      if (!view) throw new Error('No squad view yet. Run `junction sync`.');
      const mine = args.includes('--all')
        ? view.proposals
        : view.proposals.filter((p) => p.memberId === view.me);
      if (!mine.length)
        console.log(
          args.includes('--all')
            ? 'No proposals for the squad.'
            : "No proposals for you. Use --all to see the squad's.",
        );
      for (const p of mine) console.log(describeProposal(view, p));
      return;
    }

    case 'accept': {
      if (!sub) throw new Error('Give a proposal id from `junction proposals`.');
      const { results } = await app.accept(sub, { reserve: args.includes('--reserve') });
      for (const r of results)
        console.log(
          `${r.ok ? 'ok  ' : 'FAIL'} ${r.action === 'add' ? 'add' : 'remove'} ${r.code}: ${r.detail}`,
        );
      console.log('Confirmed from your schedule (GetSchedule).');
      return;
    }

    case 'decline': {
      if (!sub) throw new Error('Give a proposal id from `junction proposals`.');
      await app.decline(sub);
      console.log('Declined. Your squad will not see this proposal again for 24 hours.');
      return;
    }

    case 'undo': {
      if (!sub) throw new Error('Give the id of a proposal you accepted.');
      const { results } = await app.undo(sub);
      for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.code}: ${r.detail}`);
      return;
    }

    case 'meet': {
      const input = () => {
        const date = flag(rest, 'date');
        const start = flag(rest, 'start');
        const end = flag(rest, 'end');
        if (!date || !start || !end)
          throw new Error('Give --date YYYY-MM-DD --start HH:MM --end HH:MM (event-local time).');
        const label =
          rest.find(
            (a, i) =>
              !a.startsWith('--') &&
              !(rest[i - 1] ?? '').startsWith('--') &&
              i > (sub === 'move' ? 0 : -1),
          ) ?? 'Squad meeting point';
        const at = flag(rest, 'at');
        return { label, date, start, end, ...(at ? { location: at } : {}) };
      };
      if (sub === 'add') {
        const r = await app.createMeet(input());
        console.log(
          r.created
            ? `Added "${r.entry?.title}" (${r.entry?.personalTimeId}). Confirmed from your schedule.`
            : r.entry
              ? `Already on your schedule (${r.entry.personalTimeId}). Nothing created.`
              : 'The API did not confirm the entry. Check `junction meet list` before trying again.',
        );
        return;
      }
      if (sub === 'list') {
        const own = await app.listOwnPersonalTime();
        if (!own.length) console.log('No meeting points created by Junction.');
        for (const p of own)
          console.log(
            `${p.personalTimeId}  ${p.startDateTime} to ${p.endDateTime.slice(11)}  ${p.title}${p.location ? `, ${p.location}` : ''}`,
          );
        return;
      }
      if (sub === 'move') {
        const id = rest[0];
        if (!id) throw new Error('Give the id from `junction meet list`.');
        const p = await app.moveMeet(id, input());
        console.log(
          p
            ? `Moved to ${p.startDateTime}. Confirmed from your schedule.`
            : 'Moved, but the schedule did not show it yet.',
        );
        return;
      }
      if (sub === 'delete') {
        const id = rest[0];
        if (!id) throw new Error('Give the id from `junction meet list`.');
        console.log(
          (await app.deleteMeet(id))
            ? 'Deleted. Confirmed from your schedule.'
            : 'The entry is still on your schedule.',
        );
        return;
      }
      throw new Error('Use `junction meet add|list|move|delete`.');
    }

    case 'ui': {
      const { url } = await startUiServer(app);
      console.log(`Junction is running at ${url}. Press Ctrl+C to stop.`);
      if (!args.includes('--no-open')) openBrowser(url);
      return;
    }

    default:
      throw new Error(`Unknown command "${cmd}". Run \`junction help\`.`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof ApiError || e instanceof Error) console.error(e.message);
  else console.error('Unexpected failure.');
  process.exitCode = 1;
});
