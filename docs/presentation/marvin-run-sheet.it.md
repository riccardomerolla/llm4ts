# Marvin — scaletta per «il run è il talk»

Dieci minuti. Uno schermo: `marvin-run.html`, aperto come
`marvin-run.html#it` (oppure tasto **L**). Chi presenta non clicca durante
il run. Questa scaletta sta sul telefono o su un secondo schermo.

## Prima che la sala si riempia

- Apri `docs/presentation/marvin-run.html#it` in un browser Chromium, a
  schermo intero, e condividi quella finestra. Controlla che il titolo sia
  in Geist (i font arrivano da Google Fonts: senza rete la pagina funziona
  lo stesso, con il font di sistema).
- Premi **R** per essere sicuro che sia mostrata la schermata del titolo.
  Fai una partenza di prova di 20 secondi il giorno prima (spazio, guarda
  due corsie diventare blu, R).
- Esporta il backup il giorno prima: **P**, salva come PDF, otto pagine. Se
  la condivisione schermo muore, presenti il PDF e leggi le tappe da lì.
- Tasti durante il talk: **spazio** mette in pausa e riprende (per una
  domanda), **← →** saltano alla tappa precedente o successiva, **R**
  ricomincia.

## I dieci minuti

Il tempo del talk è l'orologio piccolo. Quello grande è il run.

### 0:00 — schermata del titolo, prima di premere spazio (circa 25 s)

> Questo è un lavoro da due ore: un servizio di integrazione per IBM ACE,
> costruito da una specifica scritta, da un flow che nessuno supervisiona.
> Lo faccio girare nei prossimi nove minuti, a quattordici volte la
> velocità. Non guardate me. Guardate i colori. E contate le decisioni che
> prende una persona. Sono due.

Premi spazio.

### 0:00 → 0:13 — lettura della specifica, stesura del piano

> Otto storie, una corsia ciascuna. Ogni corsia sono gli stessi cinque
> passi: un coder, i gate, una revisione, un giudice, un merge. Il coder è
> l'unico passo che scrive codice. Tutto quello alla sua destra esiste per
> contraddirlo.

### 0:13 — tappa 1: il piano è un documento

Il nodo `tu` è giallo e respira per tredici secondi (tre minuti di run).

> Decisione uno. Il flow ha scritto un piano: un file markdown, otto storie,
> il loro ordine, cosa vuol dire «fatto» per ciascuna. Una persona lo legge,
> lo corregge se vuole, lo approva. È l'ultima volta che una persona tocca
> questo run.

A 0:26 il nodo diventa verde e tre corsie diventano blu.

### 0:26 → 1:30 — prima ondata

> Tre coder alla volta, ognuno in una propria copia di lavoro del
> repository. Nessuno legge quello che scrivono. Non è coraggio: sono le due
> colonne successive.

### 1:30 — tappa 2: «fatto» non è un'opinione

Il nodo `gate` di S2 diventa rosso: tre test.

> Il coder ha detto fatto. La build ha detto no. Nessuno discute con il
> coder: il suo resoconto si butta via, l'output dei test diventa il suo
> prossimo input, e riparte. È il primo errore che si fa con gli agenti
> senza supervisione: fidarsi del riassunto dell'agente. Noi non lo
> leggiamo mai.

### 1:45 → 3:04 — primi merge

S1 viene integrata a 2:30, S2 a 2:51; S4 e S5 prendono gli slot liberati.

> La revisione è un altro agente con un altro mandato: restituisce rilievi,
> mai un'approvazione. Il giudice, accanto, riceve una sola domanda chiusa.

### 3:04 — tappa 3: il giudice risponde a una domanda

Il nodo `giudice` di S3 diventa rosso con `merge? 0.31`.

> «Va integrata?» Non un tema, una probabilità. C'è una soglia. Sotto la
> soglia la storia torna al coder con i rilievi allegati. Il giudice non
> scrive mai prosa, quindi non può convincersi da solo di un sì.

### 3:10 → 4:30 — S3 rivede, S4 viene integrata

> Cosa sta facendo la persona in questo momento? Niente. Un team umano
> sarebbe alla seconda ora della prima mattina.

### 4:30 — tappa 4: i run lunghi perdono il filo

Il nodo `coder` di S5 diventa arancione: contesto perso a 1h 03m.

> Dopo un'ora un coder cade. Il suo contesto è sparito; non ricorderebbe
> cosa stava facendo. La corsia non ricomincia da capo: ogni task finito era
> stato salvato in un checkpoint. Due conservati, uno rifatto. Nessuno è
> stato chiamato, perché non c'era niente da decidere.

### 4:40 → 6:00 — S3 integrata, S6 parte, lint rosso su S7

> Il secondo rosso sullo schermo è un gate di lint. Stesso meccanismo.
> Nessuno spiega l'errore al coder: l'output del gate è la spiegazione.

### 6:00 — tappa 5: l'agente è una sedia

S8 parte su un modello locale.

> Guardate le etichette delle sedie. Quattro agenti diversi hanno scritto
> questo progetto, uno è un modello che gira su un portatile. Gate, giudice
> e piano non sono cambiati. Il metodo sono le sedie e quello che c'è in
> mezzo, non chi ci si siede questo mese.

### 6:05 → 8:51 — la parte noiosa

Tutto diventa verde; `integra` gira da 8:17.

> Questa è la parte che volevo farvi vedere fino in fondo. Non succede
> niente, ed è questo che vuol dire «senza supervisione». Quali erano i gate
> in questo progetto? La build, i test unitari, un lint e un controllo di
> contratto sullo schema dei messaggi. Quattro script. Scriverli ha preso
> una mattina; sono tutto il trucco.

Se c'è una domanda: spazio, rispondi, spazio.

### 8:51 — tappa 6: due ore, due decisioni

Leggi lo schermo.

> Due ore e quattro minuti. Otto storie su otto integrate. Una persona ha
> scritto la specifica e approvato il piano. Tutto il resto è stato il flow.

### 9:16 — tappa 7: cosa non è

> Non è pensare più in fretta: è lo stesso lavoro, senza supervisione. Non
> sostituisce la specifica: una specifica sbagliata gira in due ore lo
> stesso. E non è magia: ogni nodo rosso che avete visto è un gate che
> qualcuno ha scritto una volta.

### 9:45 — tappa 8: chiusura

> Il deck, questo replay e questa scaletta sono nel repository. Domande.

## Se chiedono

- **Quei minuti sono veri?** La forma è vera: otto storie a ondate, una
  storia respinta, un coder interrotto, sedie miste, circa due ore. I
  minuti sono una ricostruzione; lo dice il piè di pagina.
- **E se non converge mai?** Una storia che fallisce i gate N volte viene
  parcheggiata e si chiede a una persona. Sarebbe stata una terza decisione.
  In questo run non è successo.
- **Cosa vede davvero il giudice?** Il diff, i rilievi, l'output dei test
  e una domanda. Risponde con una probabilità, mai con un paragrafo.
- **Com'era la specifica?** Due pagine di prosa e uno schema dei messaggi.
- **Costi?** Non sono sullo schermo di proposito. Volentieri i numeri dopo.

## Da non fare

- Nominare prodotti oltre alle sedie dei coder. Non vendere. Non dire la
  parola «sostituire».
- Cliccare durante il run. Il punto è che non serve.
- Saltare la parte noiosa. È l'argomento.
