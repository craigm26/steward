# Recording the demo

The video runs about 8.5 minutes against the 5 to 10 minute limit. Record each beat on its own, the day it works, so the last two days are editing. Reset between takes:

```sh
curl -X POST "$STEWARD_URL/api/admin/reset-demo" -H "authorization: Bearer $STEWARD_ADMIN_KEY"
```

The reset moves the app's main back to the `seed` tag, deletes every fork and candidate branch, puts the record back as seeded (with its synthetic history), and clears the board. If Workers Builds is not connected yet, keep `node scripts/preview-runner.mjs` running.

| Time | Beat | What to show | How |
| --- | --- | --- | --- |
| 0:00–0:40 | The problem | Hundreds of agent changes, one person; the scarce input is judgment, not code | Voice over the empty board |
| 0:40–1:50 | Claims | A task lands, six agents fork, the claims board fills; overlapping files are striped, so they are rivals in one decision | Board, sign in, **Open a task → Bank details changed**, then **Start the model agents** |
| 1:50–3:10 | Gate 1 | Builds, tests and Previews run; an agent that claims done and fails a check is bounced before anyone sees it, then reads why and tries again | Stay on the board; open a bounced row's **Checks** |
| 3:10–4:20 | Gate 2 | The card: Previews side by side, the judge's pick and rule, the referee's objection to each; the steward overrules once and says why | **Open the card**; pick a candidate that is not the judge's, write the reason, ship it; the **Official** seal lands |
| 4:20–5:10 | Why-blame | On a changed line: the task, the rivals it beat, the verdict, who decided and why | **Why**, `src/rules.js`, click a highlighted line |
| 5:10–6:20 | The check | The judge replayed on the steward's past calls; one path earns auto-merge, another loses it | **Paths**, **Run the check now** on Payment rules, then on Invoice queue page |
| 6:20–7:10 | Scale | 120 scripted agents on 20 translation tasks, said to be scripted: 80 broken files bounced at gate 1, most decisions merged by the judge alone on a path that earned it, the rest sampled to the steward | **Paths**, run the check on Translations; then `curl -X POST "$STEWARD_URL/api/admin/scale" -H "authorization: Bearer $STEWARD_ADMIN_KEY"` and watch the board's totals; it settles in about two minutes |
| 7:10–7:50 | Yours to run | Deploy to your own account, pick US or EU, see what is in the repo | README, `scripts/seed-app.mjs` |
| 7:50–8:30 | Close | Every merge names the person who made the call | **Ledger** |

Things worth saying on camera, because they are true:

- The agents are six different models on Workers AI, racing inside Cloudflare. Steward does not care what an agent is: Claude Code joins through the same claim.
- No agent can push to the app. Each holds a token for its own fork only; Steward copies a candidate onto a branch of the app.
- The referee is a model and can be wrong. On the first race it caught a wrong reason code that every check had missed, and on another it misread the task. The steward reads it; it decides nothing.
- With no TypeSafe key the judge is a rubric, labeled mock on the card. With Jev, set `judge.engine: typesafe`.
- The past decisions the first check replays are synthetic and labeled so. Live decisions join them as they are made.

To show a live auto-merge: after the check earns auto-merge on Payment rules, open **Unusual payment terms** and run one scripted agent that passes (`node agents/scripted.mjs --task t2 --kind terms --agents ada:small`). With a single passing candidate the judge is sure, and unless that decision is the 1 in 10 sampled for a person, it merges alone under the grant; the ledger says so.
