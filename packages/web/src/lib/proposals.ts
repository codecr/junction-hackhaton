import type { DifferenceField, Proposal, SquadView, ViewSession } from '@junction/core';
import { clock, nameList, units, weekdayName } from './format';

// Turns solver proposals (kinds and reason codes) into plain sentences. The solver never writes
// prose; the UI does, so every machine can phrase it in its own words from the same facts.

export interface ProposalText {
  title: string;
  sentence: string;
  why: string[];
  accept: string;
  decline: string;
  forMe: boolean;
  ownerName: string;
}

const FIELD_WORDS: Record<DifferenceField, string> = {
  type: 'session type',
  features: 'format',
  level: 'level',
  speakers: 'speakers',
  start: 'start time',
  venue: 'venue',
};

export function describeProposal(p: Proposal, view: SquadView): ProposalText {
  const forMe = view.me !== undefined && p.memberId === view.me;
  const owner = view.members.find((m) => m.memberId === p.memberId);
  const ownerName = owner?.name ?? 'Someone';
  const s = (id: string | undefined): ViewSession | undefined => (id ? view.sessions[id] : undefined);
  const dayOf = (v: ViewSession) => {
    const d = view.days.find((x) => x.day === v.day);
    return d ? weekdayName(d) : 'that day';
  };
  const venueOf = (v: ViewSession) => view.venues.find((x) => x.id === v.venue)?.name ?? v.venue;
  const when = (v: ViewSession) => `${dayOf(v)} at ${clock(v.startLocal)}`;
  const topicsOf = (v: ViewSession) =>
    nameList(v.topicIds.map((id) => view.topics.find((t) => t.id === id)?.label ?? id));
  const othersOn = (id: string) => {
    const dup = view.coverage.duplicates.find((d) => d.sessionId === id);
    return (dup?.attendees ?? [])
      .filter((m) => m !== p.memberId)
      .map((m) => view.members.find((x) => x.memberId === m)?.name ?? 'someone');
  };
  const attends = (names: string[]) => `${nameList(names)} ${names.length === 1 ? 'attends' : 'attend'}`;
  const subject = forMe ? 'you' : ownerName;
  const possessive = forMe ? 'yours' : `${ownerName}'s`;

  const value = (() => {
    const squad = p.squadDelta >= 0 ? `goes up by ${units(p.squadDelta)}` : `drops by ${units(p.squadDelta)}`;
    const mine =
      p.personalDelta === 0
        ? `${possessive} stays the same`
        : p.personalDelta > 0
          ? `${possessive} goes up by ${units(p.personalDelta)}`
          : `${possessive} drops by ${units(p.personalDelta)}`;
    return `Squad value ${squad} and ${mine}.`;
  })();
  const fixes = p.reasons.includes('fixes-connection') ? ' It also fixes a walk that can’t be made.' : '';

  const add = s(p.add?.[0]);
  const remove = s(p.remove?.[0]);

  switch (p.kind) {
    case 'SWAP': {
      const a = add;
      const r = remove;
      if (!a || !r) break;
      const title =
        a.day !== r.day ? `Take ${a.code} on ${dayOf(a)} instead` : `Take ${a.code} at ${clock(a.startLocal)} instead`;
      const others = othersOn(r.sessionId);
      const lead = others.length
        ? `${attends(others)} ${r.code} on ${when(r)} as well.`
        : `${r.code} is on ${when(r)}.`;
      const topics = topicsOf(a);
      const sentence = `${lead} The repeat on ${when(a)} at the ${venueOf(a)} ${
        topics ? `keeps ${topics} covered` : 'covers the same content'
      }${p.reasons.includes('removes-duplicate') ? ' without the duplicate' : ''}.${fixes}`;
      const why = [value];
      if (p.differences && p.differences.length > 0)
        why.push(
          `The two repeats differ in ${nameList(p.differences.map((f) => FIELD_WORDS[f]))}, so check the details before ${subject === 'you' ? 'you move' : `${ownerName} moves`}.`,
        );
      else why.push('The two repeats are the same session at a different time.');
      return {
        title,
        sentence,
        why,
        accept: 'Accept',
        decline: 'Not now',
        forMe,
        ownerName,
      };
    }
    case 'CLAIM': {
      const a = add;
      if (!a) break;
      const topics = topicsOf(a);
      const must = a.mustCover ? ' Your squad marked it as one somebody must attend.' : '';
      const sentence = `${when(a)} at the ${venueOf(a)}${topics ? `. It matches ${topics}` : ''}.${must} ${
        forMe ? 'You are free then and come' : `${ownerName} is free then and comes`
      } first under the squad’s claim rule.`;
      return {
        title: a.mustCover ? `${a.code} needs an owner` : `Claim ${a.code}`,
        sentence,
        why: [
          'The rule is the same on every machine: among people who can attend, the one with the fewest sessions in the topic goes first, and a tie goes to the lowest hash of member and session. The squad server confirms the first claim so two people never take the same seat.',
          value,
        ],
        accept: 'Claim it',
        decline: 'Not now',
        forMe,
        ownerName,
      };
    }
    case 'DROP': {
      const r = remove;
      if (!r) break;
      const others = othersOn(r.sessionId);
      const lead = others.length
        ? `${attends(others)} ${r.code} on ${when(r)} as well, so the squad still hears it.`
        : `${r.code} is on ${when(r)}.`;
      return {
        title: `Drop ${r.code}`,
        sentence: `${lead}${fixes}`,
        why: [value],
        accept: 'Drop it',
        decline: 'Keep it',
        forMe,
        ownerName,
      };
    }
    case 'MEET': {
      const meet = p.meet;
      if (!meet) break;
      const venue = view.venues.find((v) => v.id === meet.venue)?.name ?? meet.venue;
      const names = meet.members.map((id) => view.members.find((m) => m.memberId === id)?.name ?? 'someone');
      return {
        title: `Meet at the ${venue}, ${meet.start} to ${meet.end}`,
        sentence: `${nameList(names)} can all reach the ${venue} then and still make their next session.`,
        why: ['This adds one personal time entry to your schedule, tagged so Junction only ever edits its own.'],
        accept: 'Add to my schedule',
        decline: 'Skip',
        forMe,
        ownerName,
      };
    }
  }
  return {
    title: 'A change to your picks',
    sentence: 'The sessions this proposal names are not in your catalog yet. Sync, then look again.',
    why: [value],
    accept: 'Accept',
    decline: 'Not now',
    forMe,
    ownerName,
  };
}
