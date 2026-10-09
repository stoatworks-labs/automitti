# QLab as a player — research

2026-10-09. Sources: Figure 53's [OSC dictionary for QLab 5](https://qlab.app/docs/v5/scripting/osc-dictionary-v5/),
and the installed `/Applications/QLab.app` **5.5.10**, driven over OSC from a probe and then from
the driver itself.

**What QLab was given:** one new, unsaved workspace on the author's Mac, holding three Wait cues
(4, 3.5 and 6 s) — cues that run in time and play nothing to a screen or a speaker. One empty
Video cue (no file) was made to read its type, then deleted. No workspace of the author's was
opened, and no setting of QLab's was changed.

---

## 1. The wire

| | |
|---|---|
| Port | **53000**, TCP and UDP (per workspace it can be another; QLab itself always listens on 53000) |
| TCP framing | SLIP, double-ended (OSC 1.1) |
| UDP replies | to port **53001** on the sender, not to the port the message came from; `/udpReplyPort` changes it per client |
| UDP sessions | a client quiet for **61 s** is forgotten, passcode and all (`/forgetMeNot 1` overrides) |
| Replies | `/reply/<address the message ran as> "<json>"`, json `{ workspace_id?, address, status, data }`, status `ok` / `error` / `denied` |
| Pushed | `/update/…` messages, to a client that has sent `/updates 1` |

**The driver uses TCP.** Over UDP, a second OSC client on the machine (Companion's QLab module)
wants 53001 too; the 61-second forgetting has to be fought; and `/cueLists` for a real show is
bigger than a datagram. Over TCP, replies and updates come back on the one connection, which
stays up until either side closes it.

## 2. The session

```
→ /workspaces                                  application message, no passcode needed
← /reply/workspaces [{ uniqueID, displayName, port, udpReplyPort, version }]
→ /workspace/<id>/connect "<passcode>"         passcode optional
← "ok:view|edit|control"   the passcode's permissions
  "badpass"                wrong (status ok)
  status denied            locked out after a wrong one (§4.4)
  status error             no such workspace open
→ /updates 1                                   application message: NOT under /workspace/<id>
```

From then on everything is addressed `/workspace/<id>/…` by the unique ID, which survives a
display name with spaces in it (`Untitled Workspace`) — addressing by name doesn't.

## 3. What the driver asks, and what is pushed

| Asked | For |
|---|---|
| `/workspace/<id>/cueLists` | every list and its cues, depth first: `uniqueID`, `number`, `listName`, `type`, children in `cues` |
| `/workspace/<id>/currentCueListID` | the list in front; also the heartbeat, once a second |
| `/workspace/<id>/cue_id/<list>/playheadID` | the cue standing by, or `"none"` |
| `/workspace/<id>/runningOrPausedCues` | what is in Active Cues — every 100 ms while a clip runs, 500 ms otherwise |
| `/workspace/<id>/cue_id/<cue>/valuesForKeys '["uniqueID","number","listName","type","currentDuration","actionElapsed","isRunning","isPaused","isActionRunning"]'` | a clip's TRT, elapsed time and state |

| Pushed (with `/updates 1`) | When |
|---|---|
| `/update/workspace/<id>/cueList/<list>/playbackPosition <cue>` | the playhead moved; no argument when there is none |
| `/update/workspace/<id>/cue_id/<cue>` | a cue started, paused, resumed, stopped, ran out or was edited — and the same for its list, and `cue_id/__root__` |
| `/update/workspace/<id>` | reload the cue lists |
| `/update/workspace/<id>/disconnect` | the workspace is closing |
| `/update/workspace/<id>/dashboard` | (not in the dictionary) — ignored |

QLab pushes **no time**: elapsed has to be polled.

## 4. Seen on QLab 5.5.10 that the dictionary doesn't say (or says otherwise)

1. **No workspace open, no answer.** `/version` and `/workspaces` get no reply at all while QLab
   shows only its launcher — the dictionary says they "will always be accepted". `/thump` (no
   workspace prefix) answers `error`. The driver says "QLab is running but has no workspace open".
2. **A new workspace is passcode-locked.** QLab 5 makes up a 4-digit passcode for each new
   workspace, with View, Edit and Control, and gives **No Passcode** nothing. A connection
   without a passcode is answered `ok:` — with nothing after the colon — and then everything
   is `denied`, including `/updates`, which the dictionary says any permission level may use.
3. **`/connect` answers `ok:<permissions>`**, e.g. `ok:view|edit|control`, not the bare `ok` the
   dictionary shows.
4. **After a wrong passcode even the right one is refused.** `badpass`, then the right passcode
   60 ms later: `denied`. Five seconds later: `ok:view|edit|control`. The driver waits 30 s after
   a `badpass` and 5 s after a `denied` before it tries again.
5. **`/workspace/<id>/updates 1` is an `error`.** `/updates 1` works, and only after `/connect`.
6. **Replies come back under the address the message ran as.** `/workspace/<id>/cue/playhead/valuesForKeys`
   is answered as `/workspace/<id>/cue/2/valuesForKeys` — the playhead cue's number. The driver
   reads whose a reply is from the `uniqueID` in its data, never from the address.
7. **A cue is reset the moment it stops.** Stopped or run out, `actionElapsed` reads 0 and
   `isLoaded` false straight away. Whether a clip ran out or was stopped has to be worked out
   from what it was doing a moment before; the driver calls it run out when it left with
   0.5 s or less to go.
8. **Paused:** `isRunning` false, `isPaused` true, `isActionRunning` false; `actionElapsed` holds.
9. **GO moves the playhead at once**, before the cue's state update. GO on the last cue leaves no
   playhead (`playheadID` reads `"none"`); `/playhead/next` from the last cue went to the first.
10. **`/currentCueList` is `""` for a list without a number** (as a new workspace's is). Use
    `/currentCueListID`.
11. **An identical message ~60 ms after the first was dropped**, twice: a second `/new "wait"`,
    and a second `/playhead/next`. A third, ~120 ms after the first, was acted on. Not looked
    into further; the driver never sends the same message twice in a row that fast.
12. An unknown cue ID is answered `status: error`. A cue's type is `"Wait"`, `"Video"`,
    `"Cue List"` (QLab's names, in title case). A Video cue with no file has an empty
    `listName`, and the driver calls it by its type and number.
13. `actionElapsed` agreed with the wall clock to a few milliseconds.

## 5. QLab's words, automitti's words

QLab is a cue stack, so `current` is the clip that is running or paused, or else the clip the
playhead stands by on, and `next` is the clip after that. Only cues of the types in *Cue types
that are clips* (Video by default) count; a Light or Audio cue between two videos is passed
over. A clip that runs out stays `current` at 0 left for 2.5 s, so the rules see it end.

| automitti | QLab |
|---|---|
| play | `/cue_id/<clip>/resume` if the clip is paused; nothing if it is running; otherwise `/cue_id/<list>/go` — never a second GO before the first one's clip is seen running |
| pause | `/cue_id/<clip>/pause` |
| rewind, stoprewind | `/cue_id/<clip>/stop`, then `/cue_id/<list>/playheadID <clip>` (the top-level cue it is in) |
| stopnext | `/cue_id/<clip>/stop` — its GO already moved the playhead on |
| next / prev | `/cue_id/<list>/playhead/next` / `previous` |

## 6. What has been verified

On 2026-10-09, on QLab 5.5.10 with the Wait cues above (`node tools/qlab-check.mjs --passcode … --types Wait`):

- joining by passcode; by workspace name; the error for no passcode, a wrong passcode, a
  workspace that isn't open; riding out the lockout after a wrong passcode;
- closing the workspace while joined: QLab pushed `/update/workspace/<id>/disconnect` at once,
  and the driver said "QLab is running but has no workspace open" two seconds later;
- the cue list with TRTs, the playhead cue as `current` and the clip after it as `next`;
- play → GO, the clock running; pause holding the time; play → resume, not a second GO;
  stop-and-rewind standing by on the clip again; a clip running out held at 0 left, then the
  next clip standing by;
- **the rules end to end, through the server**, with the manual switcher: a take onto QLab's
  input GOed the cue, the clip's end AUTOed back, and *taken off → next* left the playhead on
  the next cue without firing it; the clip display counted the clip down.

**Not yet verified:** a Video cue playing (only its type was read); a cue's pre-wait; a clip
inside a Group; carts; QLab on another machine; more than one workspace open; a show-sized
workspace (the driver reloads `/cueLists` a second after any list changes, which on a big show
is a big reply); QLab 4, which this driver does not try to support.
