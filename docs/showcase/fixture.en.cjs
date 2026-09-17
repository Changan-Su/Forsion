/** Public English content for real UI captures; no generated model responses. */
module.exports = {
  project: 'Research talk',
  questionTitle: 'Research question',
  outlineTitle: 'Talk outline',
  lead: 'Connect sources, decisions, and next steps in one project note.',
  note: `# Give your next thought a starting point

Connect sources, decisions, and next steps in one project note.

> [!note] Research talk · Public sample project
> Goal: prepare a 15-minute talk on turning saved knowledge into ongoing work.

## Source material

- [[Research question]] — Why do saved sources get left behind?
- [[Talk outline]] — Three scenes: capture, think, and act
- **Working agreement**: conclusions first, then sources. Flag uncertainty separately.

## Team responsibilities

| Member | Focus | Deliverable |
| --- | --- | --- |
| Aria | Explore ways to tell the story | Two opening ideas |
| Recita | Check evidence and assumptions | Gaps and verification checklist |
| Arioso | Weigh options and plan | Talk outline and next steps |

## Next steps

- [x] Collect the project goals and sources
- [x] Define each team member's role
- [ ] Review the outline and fill in sources
- [ ] Ask Muse to follow up before the talk

`,
  question: '# Research question\n\nHow can saved sources support the next round of work?\n\nObservation: context gets repeated, conclusions stay in chat, and follow-ups get forgotten.\n',
  outline: '# Talk outline\n\n## Capture\nConnect your source material.\n\n## Think\nAsk different roles to examine your reasoning.\n\n## Act\nSave the results and plan the next review.\n',
  roles: ['Weigh options · Organize the outline', 'Explore ideas · Open up possibilities', 'Check evidence · Question assumptions'],
  teamName: 'Research talk TEAM',
  teamDescription: 'Explore directions, check evidence, and bring conclusions back to the project.',
  teamDoc: '# Shared goal\n\nPrepare a research talk with clear evidence and useful next steps.\n\n## Working agreement\n\n- Keep a source for each claim.\n- Separate facts, inferences, and open questions.\n- Share findings and write results back to the project.\n',
  mainTitle: 'Research talk · Roles and results',
  soloTitle: 'Preferences and project context',
  messages: [
    'Prepare the research talk together: Aria, explore opening ideas; Recita, check the evidence; Arioso, organize the outline. Keep open questions and next steps in the project.',
    '**🗣 Aria**\n\nStart with a concrete question: **You saved all those sources. What happens next?**\n\nFollow one project as sources become notes, shape decisions, and turn into results you can use again.',
    '**🗣 Recita**\n\nSeparate two claims: **the sources were saved**, and **the sources actually informed the work**.\n\nKeep file changes as evidence. Put unverified citations on the project checklist.',
    '**🗣 Arioso**\n\nOrganize the talk around “capture → think → act”. Review the two openings, then add the chosen direction and supporting evidence to [[Talk outline]].',
  ],
  childMessages: [
    'Check the reasoning and evidence for the research talk.',
    '## Separate sources from claims\n\n**What we know**\n- Goal: a 15-minute research talk.\n- Opening: what happens after you save a source?\n\n**Evidence to add**\n1. Show an actual change to a note file.\n2. Check one confirmed preference in the memory panel.\n3. Keep unverified citations on the project checklist.\n\n**Suggested revision**\nReplace “AI always remembers” with “You can inspect and revise important context, then use it in later work”.',
  ],
  facts: [
    'For research, lead with conclusions, then sources. Flag uncertainty separately.',
    'Current project: a 15-minute research talk, organized around capture, think, and act.',
    'After review, save the outline, evidence, and next steps in the project note. Keep source links.',
  ],
  taskTitle: 'Review sources and open questions in the talk outline',
  body: 'Two things to review before the talk: **do the sources support the claims**, and **does the outline make the next steps clear**?\n\n## This follow-up\n\n| Item | What to check |\n| --- | --- |\n| Talk outline | Each key claim has supporting evidence |\n| Project note | Each open question has an owner |\n\nAsk me to continue the review, or start a new conversation to adjust the scope.\n\n```forsion-task\ntitle: Review sources and open questions in the talk outline\ntodo: public-followup\n---\nRead the research project notes and outline. List unsupported claims and open questions. Preserve existing content and add the review to the project.\n```',
  mailTitles: ['Research talk: two open questions', 'Your sources: pick up where you left off'],
  secondMailBody: 'Open the Research talk note to continue with the sources already collected.',
  modelName: 'Public sample · No model calls',
}
