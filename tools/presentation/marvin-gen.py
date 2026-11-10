"""Generates marvin.html (EN) and marvin-it.html (IT) from one source of copy.

The engine (CSS, node animations, navigation, speaker notes) is lifted from the
committed v1 deck (24acaf82); this script replaces the slides, the scenarios
and the copy so the two languages never drift. Run from the repository root:

    python3 tools/presentation/marvin-gen.py && pnpm exec prettier --write docs/presentation/marvin*.html

Yellow <span class="tbd"> fields are placeholders the presenter fills in before
the meeting; the deck counts them in a DRAFT badge until none are left.
"""
import re, sys, json, os
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = os.path.join(REPO, "docs", "presentation") + os.sep
import subprocess
G = lambda f: subprocess.run(["git","-C",REPO,"show","24acaf82:docs/presentation/"+f],capture_output=True,text=True,check=True).stdout
en_src = G("marvin.html")
it_src = G("marvin-it.html")

css = en_src[en_src.index("<style>") + len("<style>"): en_src.index("</style>")]
it_css = it_src[it_src.index("<style>") + len("<style>"): it_src.index("</style>")]
it_over = it_css[it_css.index("/* Italian overrides"):]
script = it_src[it_src.index(";(() => {"): it_src.rindex("</script>")]
head_js = script[: script.index("/* ── scenarios ── */")]
tail_js = script[script.index("const runs = slides.map"):]

NEW_CSS = r"""
      /* ── v2 (2026-11-04): internal pitch ── */
      .tbd {
        font-family: var(--mono);
        font-size: 0.78em;
        font-weight: 500;
        color: var(--human-fg);
        border: 1.5px dashed rgba(234, 179, 8, 0.6);
        border-radius: 8px;
        padding: 0 0.35em;
        white-space: nowrap;
      }
      .tbd::before { content: "⟨ "; opacity: 0.6; }
      .tbd::after { content: " ⟩"; opacity: 0.6; }
      #draft {
        position: fixed; left: 18px; top: 14px; z-index: 5;
        font-family: var(--mono); font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--human-fg); border: 1px dashed rgba(234, 179, 8, 0.6); border-radius: 999px;
        padding: 6px 12px; background: rgba(5, 7, 11, 0.7);
      }
      #draft:empty { display: none; }
      .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; margin-top: 60px; }
      .fact { border: 1px solid var(--line-2); border-radius: 20px; padding: 30px 34px; background: rgba(14, 17, 22, 0.7); }
      .fact .v { font-size: 72px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
      .fact .k { margin-top: 16px; color: var(--muted); font-size: 27px; line-height: 1.3; }
      .s3v2 { display: grid; grid-template-columns: 800px 1fr; gap: 56px; margin-top: 6px; align-items: start; }
      .s3v2 .bigq { font-size: 64px; }
      .why { list-style: none; padding: 0; margin: 30px 0 0; display: flex; flex-direction: column; gap: 18px; }
      .why li { display: flex; gap: 18px; font-size: 23px; line-height: 1.35; color: var(--muted); }
      .why li b { color: var(--fg); font-weight: 600; }
      .why li i { font-style: normal; font-family: var(--mono); color: var(--guide); flex: none; width: 30px; padding-top: 3px; }
      .s3v2 .card .cbody { grid-template-columns: 1fr; }
      .s3v2 .card .cbody .viz { padding: 26px 22px 18px; }
      .s3v2 .card .left-out { border-left: 0; border-top: 1px solid var(--line); padding: 16px 26px 20px; }
      .s3v2 .row.zoom { transform: scale(0.86); transform-origin: left top; }
      .s3 .legend-wrap { margin-top: 26px; }
      .vid { width: 100%; max-height: 620px; aspect-ratio: 16 / 9; background: #000; border-radius: 0 0 24px 24px; display: block; object-fit: contain; }
      .card[data-mode="sim"] .vid { display: none; }
      .card:not([data-mode="sim"]) [data-sim] { display: none; }
      .card:not([data-mode="sim"]) [data-simtag] { display: none; }
      .card[data-mode="sim"] [data-rectag] { display: none; }
      .docs { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 48px; }
      .doc { font-family: var(--mono); font-size: 27px; line-height: 1.65; color: var(--muted); margin: 0; padding: 24px 32px 30px; white-space: pre-wrap; }
      .doc .hl { color: var(--fg); }
      .doc .c { color: var(--faint); }
      .proof { display: grid; grid-template-columns: 1.25fr 1fr; gap: 32px; margin-top: 36px; align-items: stretch; }
      .proof .viz { padding: 40px 30px 34px; }
      .cov { padding: 26px 32px 30px; }
      .cov .big { font-size: 72px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
      .cov .track { height: 20px; border-radius: 999px; background: rgba(255, 255, 255, 0.08); overflow: hidden; margin-top: 22px; }
      .cov .track i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--guide-dim), var(--guide)); transition: width 1.6s cubic-bezier(0.2, 0.8, 0.2, 1); }
      .cov p { color: var(--muted); font-size: 22px; margin-top: 18px; line-height: 1.4; }
      .numtable { width: 100%; border-collapse: collapse; margin-top: 56px; font-size: 32px; }
      .numtable th { font-family: var(--mono); font-size: 18px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); text-align: left; padding: 0 16px 14px; border-bottom: 1px solid var(--line-2); font-weight: 500; }
      .numtable td { padding: 34px 16px; border-bottom: 1px solid var(--line); vertical-align: top; }
      .numtable td:first-child { color: var(--fg); font-weight: 600; }
      .numtable td .s { display: block; color: var(--faint); font-size: 22px; font-weight: 400; margin-top: 4px; }
      .status { margin-top: 60px; font-size: 30px; color: var(--muted); line-height: 1.55; max-width: 1600px; }
      .status b { color: var(--fg); font-weight: 600; }
      .ask { list-style: none; padding: 0; margin: 44px 0 0; counter-reset: a; }
      .ask li { font-size: 38px; line-height: 1.35; padding-left: 80px; position: relative; margin-bottom: 30px; max-width: 1600px; }
      .ask li::before { counter-increment: a; content: counter(a); position: absolute; left: 0; top: 2px; width: 54px; height: 54px; border-radius: 14px; background: var(--human); color: #1c1917; font-family: var(--mono); font-weight: 600; display: flex; align-items: center; justify-content: center; font-size: 22px; }
      .owners { margin-top: 26px; font-size: 30px; color: var(--muted); line-height: 1.55; }
      .owners b { color: var(--fg); font-weight: 600; }
      .s8close .closing { font-size: 52px; margin-top: 18px; }
      .s8close .thanks { bottom: 118px; }
      .s8close .sigh { bottom: 170px; }
"""

def F(t):
    return f'<span class="tbd">{t}</span>'

def notes(ps):
    return '<aside class="notes">' + "".join(f"<p>{p}</p>" for p in ps) + "</aside>"

COPY = {
"en": dict(
  lang="en", title="Marvin", desc="Marvin: our legacy to the cloud, with AI agents doing the work and our people making every decision. An internal presentation by Riccardo Merolla.",
  hint="← → · space · click to move · F fullscreen · N notes",
  notes_label="Notes",
  draft="DRAFT · {n} fields to fill",
  # 1
  s1_title="Marvin", s1_kicker="Internal · WMF modernization · " + F("date"),
  s1_quote="Brain the size of a planet, and they ask me to write code.",
  s1_sub="Marvin moves our legacy to the cloud. AI agents do the work, our people make every decision, and the result is proven to match.",
  s1_who="Riccardo Merolla", s1_role="Tech Lead · WMF modernization",
  s1_keys="<kbd>←</kbd> <kbd>→</kbd> move · <kbd>F</kbd> fullscreen · <kbd>N</kbd> notes",
  s1_notes=["Hi. I'm Riccardo, Tech Lead on the WMF modernization. This is an internal pitch, and I'll own that: in ten minutes I want you to see our own COBOL running on the new stack, how it got there, and what I'm asking of you at the end.",
            "The name is Marvin, the android from The Hitchhiker's Guide to the Galaxy: a brain the size of a planet, given chores, and convinced it will all go wrong. That is a fair picture of a coding agent, which is exactly why the method never takes its word for anything.",
            "Don't panic: a person makes every decision you'll see today."],
  # 2
  s2_title="Our problem",
  s2_h=F("application name") + ": " + F("N") + " COBOL programs behind a J2EE front end, and " + F("M") + " people who can still change them.",
  s2_facts=[(F("lines"), "lines of COBOL and JSP"), (F("€ / year"), "a year to keep it alive: licences, people, incidents"), (F("years"), "since the last rewrite attempt stopped")],
  s2_lede="Rewriting it by hand never happens. It is never urgent, the people who know it are busy keeping it running, and <b>nobody can prove the new system behaves like the old one.</b> That last point is what Marvin was built for.",
  s2_notes=["Sixty seconds on our problem, in our words. Fill the three numbers from the WMF inventory; if one is not known for certain, remove the tile rather than guess.",
            "The reason the rewrite never happens is not money. It is that nobody can sign off that the new system is equivalent. Keep that word, equivalent: the demo ends on it."],
  # 3
  s3_title="The idea", s3_bigq='Agents do the volume.<br /><span class="y">People make the decisions.</span>',
  s3_lede="Supervised at the decisions: the plan, the specification, the merge. Everything between them is a flow that runs on its own and writes down every step.",
  s3_why=[("Only reviewed work is committed.", "The build and a second agent check every change. The agent never grades its own work."),
          ("Every step is a file in our repository.", "Plan, findings, progress, verdict. Stop a run anywhere, resume it anywhere."),
          ("The agent is a seat.", "Gemini CLI today, through " + F("our Vertex AI project") + "; a local model where data must not leave. Code and data stay inside our perimeter.")],
  s3_card_title="The basic loop", s3_card_desc="One task, start to commit.", s3_card_tag="simulated · what every story goes through",
  s3_left="Left behind",
  s3_legend=["how to read the runs", "waiting", "an agent is working", "done", "did not pass review", "interrupted", "needs a person"],
  s3_quip="Swap me out if you like. The process won't even notice.",
  s3_notes=["The method in one sentence: agents do the volume, people make the decisions. Not unattended: supervised at the decisions. The plan, the specification and the merge are a person's; everything between them is a flow.",
            "Three reasons to trust a run, with the smallest loop running on the right. Watch review go red: the finding is written to a file and goes back as a revision. Only then is there a commit. Done is not something the agent says about itself.",
            "On the seat, say it before anyone asks: we use Gemini CLI through our Vertex AI project, nothing leaves the tenant, and a local model is the fallback for data that must not leave at all. Confirm the exact perimeter wording with security before the meeting."],
  # 4
  s4_title="One run, recorded", s4_eyebrow="One run · " + F("module name") + " · test environment",
  s4_h="Ninety seconds of a " + F("N") + "-minute run. <span class=\"g\">The clock is real.</span>",
  s4_lede="Recorded on " + F("date") + ". Watch for three things: the run stops for the plan, a review finding sends a story back, and the replay at the end compares old and new.",
  s4_card_title="The run", s4_card_desc="Compressed; the timestamps on screen are the original ones.",
  s4_rectag="recording", s4_simtag="simulated · replace with the recording",
  s4_notes=["Not live, on purpose: a run takes an hour and never does exactly the same thing twice, and a live failure on a video call would be the only thing anyone remembers. This is a real run, compressed; the timestamps are the original ones.",
            "To make the recording: capture the run on the test environment (the watch view or a screen recorder), cut it to about ninety seconds keeping the clock visible, and save it as docs/presentation/media/marvin-run.mp4. Until that file exists the slide shows the simulation and says so.",
            "Narrate the three moments as they pass: the yellow stop, the red review, the replay."],
  # 5
  s5_title="What a person decided", s5_h="I approved the plan. <span class=\"g\">Review caught a gap I had missed.</span>",
  s5_lede="Both files are in the repository, next to the code. Nothing here was written for the slide; it is what the run left behind.",
  s5_plan_title="plan.md", s5_plan_desc="approved by " + F("name") + " on " + F("date"),
  s5_plan=['<span class="c"># ' + F("module") + " → " + F("target") + "</span>",
           '<span class="hl">stories:</span>', "  1. " + F("story 1"), "  2. " + F("story 2"), "  3. " + F("story 3"),
           '<span class="c"># owners, order, what done means: all in this file</span>',
           '<span class="y">→ stopped here until a person answered</span>'],
  s5_find_title="findings.md", s5_find_desc="review · round 1",
  s5_find=["story " + F("n") + ": " + F("the gap the review caught"),
           '<span class="r">→ did not pass · sent back as a revision</span>', "",
           '<span class="c"># round 2</span>', '<span class="g">cleared ✓</span>'],
  s5_notes=["Leave the slides for a minute: press F to leave full screen and open the real plan.md and findings.md from the run. Show the stop in the plan, your edit, and the finding. Then come back.",
            "The point: the decision was made by editing a document, and the gap was caught by a review seat, not by a person reading diffs for an afternoon."],
  # 6
  s6_title="The proof", s6_h="Old and new, same recorded inputs: <span class=\"g\">" + F("0") + " differences</span> in " + F("N") + " transactions.",
  s6_lede="Equivalence is not an opinion either. The old system's recorded behaviour is replayed against the new module, and coverage says how much of the module the recordings exercise.",
  s6_card_title="Replay", s6_card_desc="Recorded on the legacy side, replayed on the new side, compared.", s6_tag="simulated · figures from the diff report",
  s6_cov_title="Coverage", s6_cov_desc="of the module's rules exercised by the recordings",
  s6_cov_val=F("Y") + "%", s6_cov_p="The rules not covered are listed in coverage.md, each with an owner and a date.",
  s6_notes=["This is the slide the room came for. Old and new, same inputs, zero differences, and a coverage number next to it so nobody has to ask.",
            "If coverage is lower than you'd like, say what is not covered and who owns it. A true smaller number beats a round one in front of the CIO. Open diff-report.md live if there is time."],
  # 7
  s7_title="The numbers · only what we measured",
  s7_cols=["Case", "Human hours", "Agent hours", "Cost", "Review findings", "Coverage", "Output diffs"],
  s7_rows=[["IBM ACE integration<span class=\"s\">from a spec · not legacy · " + F("CREDEM project? yes / no") + "</span>", F("h"), "2 h 04 m", F("€"), F("n"), "—", "—"],
           [F("COBOL module 1") + "<span class=\"s\">test environment · " + F("date") + "</span>", F("h"), F("h"), F("€"), F("n"), F("%"), F("0")]],
  s7_status="<b>Where the migration stands:</b> done " + F("what is done") + " · proven equivalent " + F("what") + " · next " + F("module, date") + ". If a cell is empty on the day, say so and give the date it will be filled.",
  s7_notes=["No general claims: the 'weeks become hours' line is gone, because we could not defend it. One row per measured case, labelled exactly: environment, human hours, agent hours, cost, findings, coverage, output diffs.",
            "The ACE case is real but it was built from a spec, not migrated; say so. If module 1 is not finished by the meeting, leave its row with the date and say: one module, here is the diff report.",
            "Prepare the answer to 'how much of the COBOL migration is actually done?' before the meeting. It will be asked."],
  # 8
  s8_title="The ask",
  s8_closing=["Running at CREDEM today: " + F("module 1, test environment") + ".", "Sponsors: " + F("MD") + ", " + F("CIO") + ", " + F("Simone, role") + "."],
  s8_ask=["The next module: " + F("name") + ", owner " + F("name") + ", by " + F("date") + ".",
          "A compliance owner for the equivalence evidence: " + F("name") + ".",
          "Two teams run the basic loop on one real task in Q1: " + F("team") + " and " + F("team") + "."],
  s8_sigh="I would tell you not to panic, but you have already read it.",
  s8_thanks="Tech Lead · WMF modernization",
  s8_notes=["End on a decision, not applause. Name the sponsors and the owners, then ask for the three things and say who has to say yes.",
            "Before the meeting: walk Simone through the deck and let him introduce you. Get written confirmation from HR or legal that presenting an open-source project of yours internally raises no ownership question; this meeting makes it public.",
            "Then questions."],
),
"it": dict(
  lang="it", title="Marvin", desc="Marvin: il nostro legacy in cloud, con agenti AI che fanno il lavoro e le nostre persone che prendono ogni decisione. Una presentazione interna di Riccardo Merolla.",
  hint="← → · spazio · clic per muoversi · F schermo intero · N note",
  notes_label="Note",
  draft="BOZZA · {n} campi da compilare",
  s1_title="Marvin", s1_kicker="Interno · modernizzazione WMF · " + F("data"),
  s1_quote="Un cervello grande come un pianeta, e mi chiedono di scrivere codice.",
  s1_sub="Marvin porta il nostro legacy in cloud. Gli agenti AI fanno il lavoro, le nostre persone prendono ogni decisione, e il risultato è dimostrato equivalente.",
  s1_who="Riccardo Merolla", s1_role="Tech Lead · modernizzazione WMF",
  s1_keys="<kbd>←</kbd> <kbd>→</kbd> muoversi · <kbd>F</kbd> schermo intero · <kbd>N</kbd> note",
  s1_notes=["Ciao. Sono Riccardo, Tech Lead della modernizzazione WMF. Questa è una presentazione interna, e me ne assumo la responsabilità: in dieci minuti voglio farvi vedere il nostro COBOL che gira sul nuovo stack, come ci è arrivato, e cosa vi chiedo alla fine.",
            "Il nome è Marvin, l'androide della Guida galattica per gli autostoppisti: un cervello grande come un pianeta, messo a fare commissioni, convinto che andrà tutto male. È un ritratto onesto di un agente di coding, ed è proprio per questo che il metodo non si fida mai della sua parola.",
            "Niente panico: ogni decisione che vedrete oggi la prende una persona."],
  s2_title="Il nostro problema",
  s2_h=F("nome applicazione") + ": " + F("N") + " programmi COBOL dietro un front end J2EE, e " + F("M") + " persone che sanno ancora modificarli.",
  s2_facts=[(F("righe"), "righe di COBOL e JSP"), (F("€ / anno"), "all'anno per tenerla in vita: licenze, persone, incidenti"), (F("anni"), "dall'ultimo tentativo di riscrittura abbandonato")],
  s2_lede="Riscriverla a mano non succede mai. Non è mai urgente, chi la conosce è occupato a tenerla in piedi, e <b>nessuno può dimostrare che il nuovo sistema si comporti come il vecchio.</b> Marvin è nato per quest'ultimo punto.",
  s2_notes=["Sessanta secondi sul nostro problema, con le nostre parole. Compila i tre numeri dall'inventario WMF; se uno non è certo, togli il riquadro invece di tirare a indovinare.",
            "Il motivo per cui la riscrittura non succede mai non sono i soldi. È che nessuno può firmare che il nuovo sistema è equivalente. Tieni quella parola, equivalente: la demo finisce lì."],
  s3_title="L'idea", s3_bigq='Gli agenti fanno il volume.<br /><span class="y">Le persone prendono le decisioni.</span>',
  s3_lede="Supervisionato nelle decisioni: il piano, la specifica, il merge. Tutto quello che sta in mezzo è un flow che gira da solo e mette per iscritto ogni passo.",
  s3_why=[("Solo il lavoro revisionato finisce in commit.", "La build e un secondo agente controllano ogni modifica. L'agente non si corregge mai i compiti da solo."),
          ("Ogni passo è un file nel nostro repository.", "Piano, rilievi, avanzamento, verdetto. Un run si ferma ovunque e riparte da dove era."),
          ("L'agente è una sedia.", "Oggi Gemini CLI, attraverso " + F("il nostro progetto Vertex AI") + "; un modello locale dove i dati non possono uscire. Codice e dati restano nel nostro perimetro.")],
  s3_card_title="Il ciclo base", s3_card_desc="Un task, dall'inizio al commit.", s3_card_tag="simulato · quello che passa ogni story",
  s3_left="Cosa resta",
  s3_legend=["come leggere i run", "in attesa", "un agente lavora", "fatto", "non ha passato la review", "interrotto", "serve una persona"],
  s3_quip="Sostituitemi pure. Il processo non se ne accorgerà nemmeno.",
  s3_notes=["Il metodo in una frase: gli agenti fanno il volume, le persone prendono le decisioni. Non «senza supervisione»: supervisionato nelle decisioni. Piano, specifica e merge sono di una persona; tutto il resto è un flow.",
            "Tre motivi per fidarsi di un run, con il ciclo più piccolo che gira a destra. Guardate la review diventare rossa: il rilievo va in un file e torna indietro come revisione. Solo allora c'è un commit. «Fatto» non è qualcosa che l'agente dice di sé.",
            "Sulla sedia, dillo prima che lo chiedano: usiamo Gemini CLI attraverso il nostro progetto Vertex AI, niente esce dal tenant, e un modello locale è la riserva per i dati che non possono uscire affatto. Conferma la formulazione esatta del perimetro con la sicurezza prima della riunione."],
  s4_title="Un run, registrato", s4_eyebrow="Un run · " + F("nome modulo") + " · ambiente di test",
  s4_h="Novanta secondi di un run da " + F("N") + " minuti. <span class=\"g\">L'orologio è vero.</span>",
  s4_lede="Registrato il " + F("data") + ". Tre cose da guardare: il run si ferma per il piano, un rilievo della review rimanda indietro una story, e il replay finale confronta vecchio e nuovo.",
  s4_card_title="Il run", s4_card_desc="Compresso; i timestamp sullo schermo sono quelli originali.",
  s4_rectag="registrazione", s4_simtag="simulato · da sostituire con la registrazione",
  s4_notes=["Non dal vivo, di proposito: un run dura un'ora e non fa mai esattamente la stessa cosa due volte, e un fallimento in diretta in videochiamata sarebbe l'unica cosa che la gente ricorderebbe. Questo è un run vero, compresso; i timestamp sono quelli originali.",
            "Per fare la registrazione: cattura il run sull'ambiente di test (la vista watch o un registratore dello schermo), taglialo a circa novanta secondi tenendo l'orologio visibile, e salvalo come docs/presentation/media/marvin-run.mp4. Finché il file non esiste la slide mostra la simulazione e lo dichiara.",
            "Racconta i tre momenti mentre passano: lo stop giallo, la review rossa, il replay."],
  s5_title="Cosa ha deciso una persona", s5_h="Ho approvato il piano. <span class=\"g\">La review ha trovato una lacuna che mi era sfuggita.</span>",
  s5_lede="Entrambi i file sono nel repository, accanto al codice. Niente qui è stato scritto per la slide: è quello che il run ha lasciato.",
  s5_plan_title="plan.md", s5_plan_desc="approvato da " + F("nome") + " il " + F("data"),
  s5_plan=['<span class="c"># ' + F("modulo") + " → " + F("target") + "</span>",
           '<span class="hl">story:</span>', "  1. " + F("story 1"), "  2. " + F("story 2"), "  3. " + F("story 3"),
           '<span class="c"># responsabili, ordine, cosa vuol dire fatto: tutto in questo file</span>',
           '<span class="y">→ fermo qui finché una persona non ha risposto</span>'],
  s5_find_title="findings.md", s5_find_desc="review · giro 1",
  s5_find=["story " + F("n") + ": " + F("la lacuna trovata dalla review"),
           '<span class="r">→ non passata · rimandata come revisione</span>', "",
           '<span class="c"># giro 2</span>', '<span class="g">risolta ✓</span>'],
  s5_notes=["Lascia le slide per un minuto: premi F per uscire dallo schermo intero e apri i veri plan.md e findings.md del run. Mostra lo stop nel piano, la tua modifica, e il rilievo. Poi torna.",
            "Il punto: la decisione è stata presa modificando un documento, e la lacuna l'ha trovata una sedia di review, non una persona che legge diff per un pomeriggio."],
  s6_title="La prova", s6_h="Vecchio e nuovo, stessi input registrati: <span class=\"g\">" + F("0") + " differenze</span> su " + F("N") + " transazioni.",
  s6_lede="Nemmeno l'equivalenza è un'opinione. Il comportamento registrato del vecchio sistema viene rieseguito sul nuovo modulo, e la copertura dice quanta parte del modulo le registrazioni esercitano.",
  s6_card_title="Replay", s6_card_desc="Registrato sul lato legacy, rieseguito sul lato nuovo, confrontato.", s6_tag="simulato · cifre dal diff report",
  s6_cov_title="Copertura", s6_cov_desc="delle regole del modulo esercitate dalle registrazioni",
  s6_cov_val=F("Y") + "%", s6_cov_p="Le regole non coperte sono elencate in coverage.md, ognuna con un responsabile e una data.",
  s6_notes=["Questa è la slide per cui la sala è venuta. Vecchio e nuovo, stessi input, zero differenze, e un numero di copertura accanto così nessuno deve chiederlo.",
            "Se la copertura è più bassa di quanto vorresti, di' cosa non è coperto e chi ne è responsabile. Un numero vero e piccolo batte un numero tondo davanti al CIO. Apri diff-report.md dal vivo se c'è tempo."],
  s7_title="I numeri · solo quello che abbiamo misurato",
  s7_cols=["Caso", "Ore umane", "Ore agenti", "Costo", "Rilievi review", "Copertura", "Diff output"],
  s7_rows=[["Integrazione IBM ACE<span class=\"s\">da una specifica · non legacy · " + F("progetto CREDEM? sì / no") + "</span>", F("h"), "2 h 04 m", F("€"), F("n"), "—", "—"],
           [F("modulo COBOL 1") + "<span class=\"s\">ambiente di test · " + F("data") + "</span>", F("h"), F("h"), F("€"), F("n"), F("%"), F("0")]],
  s7_status="<b>A che punto è la migrazione:</b> fatto " + F("cosa è fatto") + " · dimostrato equivalente " + F("cosa") + " · prossimo " + F("modulo, data") + ". Se il giorno della riunione una cella è vuota, dillo e dai la data in cui sarà riempita.",
  s7_notes=["Nessuna affermazione generale: la riga «le settimane diventano ore» è sparita, perché non potevamo difenderla. Una riga per caso misurato, etichettata esattamente: ambiente, ore umane, ore agenti, costo, rilievi, copertura, differenze in output.",
            "Il caso ACE è vero ma è stato costruito da una specifica, non migrato; dillo. Se il modulo 1 non è finito per la riunione, lascia la sua riga con la data e di': un modulo, ecco il diff report.",
            "Prepara prima della riunione la risposta a «quanta parte della migrazione COBOL è davvero fatta?». La faranno."],
  s8_title="La richiesta",
  s8_closing=["In esercizio oggi in CREDEM: " + F("modulo 1, ambiente di test") + ".", "Sponsor: " + F("MD") + ", " + F("CIO") + ", " + F("Simone, ruolo") + "."],
  s8_ask=["Il prossimo modulo: " + F("nome") + ", responsabile " + F("nome") + ", entro " + F("data") + ".",
          "Un referente compliance per le evidenze di equivalenza: " + F("nome") + ".",
          "Due team eseguono il ciclo base su un task reale nel Q1: " + F("team") + " e " + F("team") + "."],
  s8_sigh="Vi direi di non farvi prendere dal panico, ma l'avete già letto.",
  s8_thanks="Tech Lead · modernizzazione WMF",
  s8_notes=["Chiudi con una decisione, non con un applauso. Nomina sponsor e responsabili, poi chiedi le tre cose e di' chi deve dire di sì.",
            "Prima della riunione: fai vedere il deck a Simone e lascia che sia lui a presentarti. Fatti dare conferma scritta da HR o legale che presentare internamente un progetto open source tuo non apre una questione di proprietà; questa riunione lo rende pubblico.",
            "Poi le domande."],
),
}

L_IT = {
  "Notes": "Note", "Nothing yet.": "Ancora niente.",
  "DRAFT · {n} fields to fill": "BOZZA · {n} campi da compilare",
  "plan": "piano", "code": "codice", "checks": "controlli", "review": "review", "commit": "commit",
  "3 tasks": "3 task", "three tasks, in order": "tre task, in ordine",
  "No test for an empty statement": "Manca un test per l'estratto conto vuoto",
  "round 1: one issue, sent back as a revision": "giro 1: un problema, rimandato come revisione",
  "Revision: add the missing test": "Revisione: aggiungi il test mancante",
  "clean": "pulita", "round 2: cleared": "giro 2: risolto",
  "one commit per reviewed task": "un commit per ogni task revisionato",
  "back as a revision": "torna indietro come revisione",
  "owns model/": "possiede model/", "owns api/": "possiede api/", "owns statements/": "possiede statements/", "owns ui/": "possiede ui/",
  "after 2–4": "dopo la 2–4", "epic": "epic", "one branch": "un solo branch",
  "in parallel · each in its own copy of the repo": "in parallelo · ognuna nella sua copia del repo",
  "merged": "integrata", "epic branch": "branch dell'epic", "{n} of 5 stories merged": "{n} story su 5 integrate",
  "five stories, their files and dependencies": "cinque story, i loro file e le dipendenze",
  "Judge: totals not covered": "Giudice: totali non coperti", "story-3 findings": "rilievi story 3",
  "judge round 1: one gap, revision added": "giudice, giro 1: una lacuna, aggiunta una revisione",
  "judge round 1: one gap · round 2: cleared": "giudice, giro 1: una lacuna · giro 2: risolta",
  "5/5 merged": "5/5 integrate", "what ran, where time went, what it cost": "cosa è girato, dove è andato il tempo, quanto è costato",
  "record": "registra", "legacy · test env": "legacy · ambiente di test", "replay": "replay", "new module": "nuovo modulo",
  "compare": "confronta", "recorded": "registrato", "replayed": "rieseguito", "identical ✓": "identico ✓",
  "recordings.jsonl": "recordings.jsonl", "the old system's behaviour, as data": "il comportamento del vecchio sistema, come dati",
  "diff-report.md": "diff-report.md", "every transaction, old vs new": "ogni transazione, vecchio contro nuovo",
  "coverage.md": "coverage.md", "rules exercised · rules not, with owners": "regole esercitate · regole no, con responsabili",
}

SCEN = r"""
        /* ── scenarios (v2) ── */
        const S = {}

        S[1] = {
          delay: 500,
          reset(c) {
            $(".quote .t", c.root).textContent = ""
          },
          async run(c) {
            const q = $(".quote", c.root),
              t = $(".t", q),
              txt = q.dataset.type
            if (reduce) {
              t.textContent = txt
              return
            }
            for (let i = 1; i <= txt.length; i++) {
              t.textContent = txt.slice(0, i)
              await c.sleep(txt[i - 1] === "," ? 260 : 34)
            }
          }
        }

        S[3] = {
          delay: 1200,
          build(c) {
            this.row = $("[data-row]", c.root)
            this.viz = this.row.parentElement
            this.n = ["plan", "code", "checks", "review", "commit"].map((k) => c.node(k))
            c.chain(this.row, this.n)
            this.svg = $("[data-arc]", c.root)
            this.path = $("path", this.svg)
            this.text = $("text", this.svg)
            this.svg.insertAdjacentHTML(
              "afterbegin",
              '<defs><marker id="ah" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#f87171"/></marker></defs>'
            )
            this.path.setAttribute("marker-end", "url(#ah)")
          },
          reset() {
            this.path.classList.remove("on")
            this.text.classList.remove("on")
          },
          arc() {
            const a = rel(this.n[3].box, this.viz),
              b = rel(this.n[1].box, this.viz),
              lab = rel(this.n[3].root, this.viz)
            const y = lab.y + lab.h + 14,
              x1 = a.x + a.w / 2,
              x2 = b.x + b.w / 2
            this.path.setAttribute("d", `M ${x1} ${y} C ${x1} ${y + 70}, ${x2} ${y + 70}, ${x2} ${y + 4}`)
            this.text.setAttribute("x", (x1 + x2) / 2 - 60)
            this.text.setAttribute("y", y + 82)
            this.text.textContent = tr("back as a revision")
            this.path.classList.add("on")
            this.text.classList.add("on")
          },
          async run(c) {
            const [plan, code, checks, review, commit] = this.n
            plan.run()
            await c.sleep(1000)
            plan.done("3 tasks")
            c.art("plan.md", "three tasks, in order")
            code.run()
            await c.sleep(1300)
            code.done("+84 −12")
            checks.run()
            await c.sleep(900)
            checks.done("4/4 ✓")
            review.run()
            await c.sleep(1100)
            review.fail("No test for an empty statement")
            c.art("findings.md", "round 1: one issue, sent back as a revision")
            this.arc()
            await c.sleep(2000)
            checks.idle()
            review.idle()
            code.run()
            code.note("Revision: add the missing test", 1600)
            await c.sleep(1300)
            code.done("+97 −12")
            this.path.classList.remove("on")
            this.text.classList.remove("on")
            checks.run()
            await c.sleep(800)
            checks.done("5/5 ✓")
            review.run()
            await c.sleep(1000)
            review.done("clean")
            c.art("findings.md", "round 2: cleared")
            commit.run()
            await c.sleep(700)
            commit.done("a1f3c9e")
            c.art("git commit", "one commit per reviewed task")
          }
        }

        /* the recording, with the simulated epic run as a fallback until media/marvin-run.mp4 exists */
        S[4] = {
          delay: 400,
          build(c) {
            this.card = $(".card", c.root)
            this.video = $("video", c.root)
            const sim = () => (this.card.dataset.mode = "sim")
            this.video.addEventListener("error", sim)
            /* no metadata after a moment: the file is missing (or blocked), show the simulation */
            setTimeout(() => {
              if (this.video.readyState < 1) sim()
            }, 1500)
            const dag = $("[data-dag]", c.root)
            const h = { h: true }
            this.s = [
              c.node("story 1", "owns model/", h),
              c.node("story 2", "owns api/", h),
              c.node("story 3", "owns statements/", h),
              c.node("story 4", "owns ui/", h),
              c.node("story 5", "after 2–4", h)
            ]
            this.epic = c.node("epic", "one branch", h)
            const lanes = el("div", "lanes")
            lanes.append(el("div", "lanes-cap", tr("in parallel · each in its own copy of the repo")))
            this.s.slice(1, 4).forEach((n) => lanes.append(n.root))
            dag.append(this.s[0].root, c.arrow(), lanes, c.arrow(), this.s[4].root, c.arrow(), this.epic.root)
          },
          reset() {
            if (this.video && !this.video.paused) this.video.pause()
          },
          async run(c) {
            if (this.card.dataset.mode !== "sim" && this.video.readyState < 1) {
              await c.sleep(1600)
              if (this.video.readyState < 1) this.card.dataset.mode = "sim"
            }
            if (this.card.dataset.mode !== "sim") {
              try {
                this.video.currentTime = 0
                await this.video.play()
              } catch (e) {
                /* autoplay blocked: the presenter presses play */
              }
              return
            }
            const [s1, s2, s3, s4, s5] = this.s,
              epic = this.epic
            let merged = 0
            const merge = (n) => {
              merged++
              n.done("merged")
              c.art("epic branch", tr("{n} of 5 stories merged", { n: merged }))
            }
            c.art("plan.md", "five stories, their files and dependencies")
            epic.run()
            s1.run()
            await c.sleep(1200)
            merge(s1)
            await Promise.all([
              (async () => {
                s2.run()
                await c.sleep(1700)
                merge(s2)
              })(),
              (async () => {
                s3.run()
                await c.sleep(1100)
                s3.fail("Judge: totals not covered")
                c.art("story-3 findings", "judge round 1: one gap, revision added")
                await c.sleep(1700)
                s3.run()
                await c.sleep(1100)
                merge(s3)
                c.art("story-3 findings", "judge round 1: one gap · round 2: cleared")
              })(),
              (async () => {
                s4.run()
                await c.sleep(2100)
                merge(s4)
              })()
            ])
            s5.run()
            await c.sleep(1300)
            merge(s5)
            epic.done("5/5 merged")
            c.art("report.md", "what ran, where time went, what it cost")
          }
        }

        S[6] = {
          delay: 900,
          build(c) {
            this.n = [c.node("record", "legacy · test env"), c.node("replay", "new module"), c.node("compare")]
            c.chain($("[data-row]", c.root), this.n)
            this.bar = $("[data-cov] i", c.root)
            this.cov = Number($("[data-cov]", c.root).dataset.cov) || 0
          },
          reset() {
            if (this.bar) {
              this.bar.style.transition = "none"
              this.bar.style.width = "0"
            }
          },
          async run(c) {
            const [rec, rep, cmp] = this.n
            rec.run()
            await c.sleep(1100)
            rec.done("recorded")
            c.art("recordings.jsonl", "the old system's behaviour, as data")
            rep.run()
            await c.sleep(1400)
            rep.done("replayed")
            cmp.run()
            await c.sleep(1200)
            cmp.done("identical ✓")
            c.art("diff-report.md", "every transaction, old vs new")
            await c.sleep(500)
            this.bar.style.transition = ""
            this.bar.style.width = `${this.cov}%`
            c.art("coverage.md", "rules exercised · rules not, with owners")
          }
        }

        /* draft badge: how many fields are still placeholders */
        {
          const d = $("#draft"),
            n = $$(".tbd").length
          d.textContent = n ? tr("DRAFT · {n} fields to fill", { n }) : ""
        }

"""

def slides(C):
    legend = C["s3_legend"]
    s = []
    s.append(f'''
        <!-- 1 -->
        <section class="slide s1" data-title="{C['s1_title']}">
          <div class="panic-badge in" style="--d: 1600">DON'T PANIC</div>
          {PLANET}
          <p class="kicker in">{C['s1_kicker']}</p>
          <h1 class="in" style="--d: 120">Marvin</h1>
          <p class="quote" data-type="“{C['s1_quote']}”">
            <span class="t"></span><span class="caret"></span>
          </p>
          <p class="sub in" style="--d: 400">{C['s1_sub']}</p>
          <div class="who in" style="--d: 600">
            <b>{C['s1_who']}</b><i class="sep"></i><span>{C['s1_role']}</span>
          </div>
          <p class="keys in" style="--d: 900">{C['s1_keys']}</p>
          {notes(C['s1_notes'])}
        </section>
''')
    facts = "".join(f'<div class="fact in" style="--d: {250 + i * 150}"><div class="v">{v}</div><div class="k">{k}</div></div>' for i, (v, k) in enumerate(C["s2_facts"]))
    s.append(f'''
        <!-- 2 -->
        <section class="slide s2" data-title="{C['s2_title']}">
          <p class="eyebrow in">{C['s2_title']}</p>
          <h2 class="title in" style="--d: 100; max-width: 1680px">{C['s2_h']}</h2>
          <div class="facts">{facts}</div>
          <p class="lede in" style="--d: 700; max-width: 1650px; margin-top: 60px; font-size: 34px">{C['s2_lede']}</p>
          {notes(C['s2_notes'])}
        </section>
''')
    why = "".join(f'<li class="in" style="--d: {350 + i * 150}"><i>0{i + 1}</i><span><b>{b}</b> {t}</span></li>' for i, (b, t) in enumerate(C["s3_why"]))
    leg = "".join(f'<span><i style="background: var(--{v})"></i>{t}</span>' for v, t in zip(["idle); opacity: 0.6", "run", "ok", "err", "int", "human"], legend[1:]))
    s.append(f'''
        <!-- 3 -->
        <section class="slide s3" data-title="{C['s3_title']}">
          <p class="eyebrow in">{C['s3_title']}</p>
          <div class="s3v2">
            <div>
              <p class="bigq in" style="--d: 100">{C['s3_bigq']}</p>
              <p class="lede in" style="--d: 250; font-size: 26px">{C['s3_lede']}</p>
              <ol class="why">{why}</ol>
            </div>
            <div class="card hero-card in" style="--d: 300">
              <div class="card-head">
                <div>
                  <p class="card-title">{C['s3_card_title']}</p>
                  <p class="card-desc">{C['s3_card_desc']}</p>
                </div>
                <span class="tag">{C['s3_card_tag']}</span>
              </div>
              <div class="cbody">
                <div class="viz">
                  <svg class="arc" data-arc aria-hidden="true"><path d="" /><text></text></svg>
                  <div class="row zoom" data-row></div>
                </div>
                <div class="left-out">
                  <h4>{C['s3_left']}</h4>
                  <ul class="arts" data-arts></ul>
                </div>
              </div>
            </div>
          </div>
          <div class="legend-wrap in" style="--d: 800">
            <div class="legend" aria-label="Legend">
              <span class="tag">{legend[0]}</span>
              {leg}
            </div>
          </div>
          <p class="quip">Marvin: <em>{C['s3_quip']}</em></p>
          {notes(C['s3_notes'])}
        </section>
''')
    s.append(f'''
        <!-- 4 -->
        <section class="slide s4" data-title="{C['s4_title']}">
          <p class="eyebrow in">{C['s4_eyebrow']}</p>
          <h2 class="title in" style="--d: 100">{C['s4_h']}</h2>
          <p class="lede in" style="--d: 250; max-width: 1600px">{C['s4_lede']}</p>
          <div class="card hero-card in" style="--d: 350">
            <div class="card-head">
              <div>
                <p class="card-title">{C['s4_card_title']}</p>
                <p class="card-desc">{C['s4_card_desc']}</p>
              </div>
              <span class="tag" data-rectag>{C['s4_rectag']}</span>
              <span class="tag" data-simtag>{C['s4_simtag']}</span>
            </div>
            <video class="vid" src="media/marvin-run.mp4" muted playsinline controls preload="metadata"></video>
            <div data-sim>
              <div class="viz" style="padding-top: 22px; padding-bottom: 20px">
                <div class="dag" data-dag></div>
              </div>
              <div class="left-out">
                <h4>{C['s3_left']}</h4>
                <ul class="arts cols" data-arts></ul>
              </div>
            </div>
          </div>
          {notes(C['s4_notes'])}
        </section>
''')
    plan = "\n".join(C["s5_plan"]); find = "\n".join(C["s5_find"])
    s.append(f'''
        <!-- 5 -->
        <section class="slide s5" data-title="{C['s5_title']}">
          <p class="eyebrow in">{C['s5_title']}</p>
          <h2 class="title in" style="--d: 100; max-width: 1700px">{C['s5_h']}</h2>
          <p class="lede in" style="--d: 250; max-width: 1600px">{C['s5_lede']}</p>
          <div class="docs">
            <div class="card in" style="--d: 350">
              <div class="card-head">
                <div><p class="card-title">{C['s5_plan_title']}</p><p class="card-desc">{C['s5_plan_desc']}</p></div>
                <span class="tag">human</span>
              </div>
              <pre class="doc">{plan}</pre>
            </div>
            <div class="card in" style="--d: 500">
              <div class="card-head">
                <div><p class="card-title">{C['s5_find_title']}</p><p class="card-desc">{C['s5_find_desc']}</p></div>
                <span class="tag">review</span>
              </div>
              <pre class="doc">{find}</pre>
            </div>
          </div>
          {notes(C['s5_notes'])}
        </section>
''')
    s.append(f'''
        <!-- 6 -->
        <section class="slide s6" data-title="{C['s6_title']}">
          <p class="eyebrow in">{C['s6_title']}</p>
          <h2 class="title in" style="--d: 100; max-width: 1700px">{C['s6_h']}</h2>
          <p class="lede in" style="--d: 250; max-width: 1600px">{C['s6_lede']}</p>
          <div class="proof">
            <div class="card in" style="--d: 350">
              <div class="card-head">
                <div><p class="card-title">{C['s6_card_title']}</p><p class="card-desc">{C['s6_card_desc']}</p></div>
                <span class="tag">{C['s6_tag']}</span>
              </div>
              <div class="viz"><div class="row" data-row></div></div>
              <div class="left-out">
                <h4>{C['s3_left']}</h4>
                <ul class="arts cols" data-arts></ul>
              </div>
            </div>
            <div class="card in" style="--d: 500">
              <div class="card-head">
                <div><p class="card-title">{C['s6_cov_title']}</p><p class="card-desc">{C['s6_cov_desc']}</p></div>
              </div>
              <div class="cov">
                <div class="big">{C['s6_cov_val']}</div>
                <div class="track" data-cov data-cov="0"><i></i></div>
                <p>{C['s6_cov_p']}</p>
              </div>
            </div>
          </div>
          {notes(C['s6_notes'])}
        </section>
''')
    th = "".join(f"<th>{c}</th>" for c in C["s7_cols"])
    tr_ = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in C["s7_rows"])
    s.append(f'''
        <!-- 7 -->
        <section class="slide s7" data-title="{C['s7_title']}">
          <p class="eyebrow in">{C['s7_title']}</p>
          <table class="numtable in" style="--d: 150">
            <thead><tr>{th}</tr></thead>
            <tbody>{tr_}</tbody>
          </table>
          <p class="status in" style="--d: 500">{C['s7_status']}</p>
          {notes(C['s7_notes'])}
        </section>
''')
    closing = "".join(f'<span class="in" style="--d: {200 + i * 500}; display: block">{t}</span>' for i, t in enumerate(C["s8_closing"]))
    ask = "".join(f'<li class="in" style="--d: {1200 + i * 400}">{t}</li>' for i, t in enumerate(C["s8_ask"]))
    s.append(f'''
        <!-- 8 -->
        <section class="slide s8 s11 s8close" data-title="{C['s8_title']}">
          <p class="eyebrow in">{C['s8_title']}</p>
          <p class="owners">{closing}</p>
          <ol class="ask">{ask}</ol>
          <p class="sigh in" style="--d: 2600"><b>Marvin:</b> {C['s8_sigh']}</p>
          <p class="thanks in" style="--d: 2900"><b>{C['s1_who']}</b> · {C['s8_thanks']}</p>
          <div class="dontpanic" aria-label="Don't Panic">DON'T PANIC</div>
          {notes(C['s8_notes'])}
        </section>
''')
    return "".join(s)

m = re.search(r'<div class="planet-wrap.*?</div>\s*</div>\s*</div>\s*</div>', en_src, re.S)
PLANET = m.group(0)

def build(lang):
    C = COPY[lang]
    L = json.dumps(L_IT if lang == "it" else {}, ensure_ascii=False, indent=2)
    hint = C["hint"]
    html = f'''<!doctype html>
<html lang="{lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <!-- Marvin v2 (2026-11-04): an internal pitch, eight slides, three moments (our problem, one real run, the ask).
     Generated for both languages from one script; yellow ⟨ fields ⟩ are placeholders to fill before presenting. -->
    <title>Marvin</title>
    <meta name="description" content="{C['desc']}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600&family=Fredoka:wght@600&display=swap"
    />
    <style>{css}{it_over if lang == "it" else ""}{NEW_CSS}
    </style>
  </head>
  <body>
    <canvas id="stars" aria-hidden="true"></canvas>
    <div class="nebula" aria-hidden="true"></div>
    <div id="progress"></div>
    <div id="draft"></div>
    <div class="hint" id="hint">{hint}</div>
    <div id="viewport">
      <main id="stage" aria-live="polite">
{slides(C)}
        <div id="cursor" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6L9.6 20z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round" /></svg><span class="ring"></span>
        </div>
        <nav class="chrome" aria-label="Slide navigation">
          <button data-nav="-1" aria-label="Previous slide">‹</button><span class="num" id="num">01 / 8</span><button data-nav="1" aria-label="Next slide">›</button>
        </nav>
      </main>
    </div>
    <aside id="notes" aria-label="Speaker notes">
      <h5 id="notes-h">{C['notes_label']}</h5>
      <div id="notes-body"></div>
    </aside>

    <script>
      window.MARVIN_L = {L}
      {head_js}{SCEN}{tail_js}</script>
  </body>
</html>
'''
    return html

open(ROOT + "marvin.html", "w").write(build("en"))
open(ROOT + "marvin-it.html", "w").write(build("it"))
print("written")
