When a script reports what happened in a time window that the next run continues from, end the window a little in the past (GitHub search lags behind a merge) and in whole seconds, and make the stored end exactly the bound the filter used.

**Why:** `status-update.ts` ended its window at the raw `new Date()`: a PR merged seconds before a run wasn't in GitHub's search index yet and was skipped by both that run and the next; and the end was filtered with milliseconds but stored floored to seconds, so an item at that exact second could be reported twice.
**Source:** https://github.com/v-goncharov/ai-workshop-start/pull/28#discussion_r4718993689
