# music-tools

An interactive circle of fifths — a tool for exploring harmony, building chord progressions, and playing them back.

**[Live demo](https://evgenykon.github.io/music-tools/)**

![music-tools](public/img.png)

## Features

- **Circle of fifths:** 12 notes arranged clockwise, highlighting the tonic and scale degrees
- **Key selection:** major, natural/harmonic/melodic minor
- **Scale & chords:** scale degrees I–VII with chord types
- **Theory panel:** reference for key signatures, scale degrees, and chromatic notes
- **Player:** 50 built-in chord progressions, chords and arpeggios, 3 instruments (piano, guitar, organ), adjustable tempo, metronome
- **Visualization:** chord movement graph inside the circle, current chord highlighting
- **Chord detector:** vertical guitar fretboard (5 frets with scroll along the neck), clickable strings,
  open strings and tuning presets — the chord name is recognized automatically
  ([`/chords`](https://evgenykon.github.io/music-tools/chords))
- **Chord tree:** pick a central chord and see every allowed progression branching out from it in all
  directions; branches end on a chord that can return to the centre. Filter by mode, style
  (functional, pop, rock, blues, jazz), triads/sevenths, mood (light, sad, tense) and depth 2–8.
  Chords keep one colour (major warm, minor cold); clicking a chord shows its fingering on the neck
  ([`/tree`](https://evgenykon.github.io/music-tools/tree))

- **Rehearsal notebook:** A4 page per screen with an 8×4 interactive table — part labels (Intro, Chorus…)
  in a narrow vertical strip, up to 4 chords per cell, a note field, a chord diagram picker and a
  tab editor (up to 8 notes). Multiple pages, autosave to localStorage, JSON export/import and printing
  ([`/notebook`](https://evgenykon.github.io/music-tools/notebook))

- **Practice check:** open a GTP/MusicXML file, record yourself playing along — 4 count-in clicks,
  then the score and the microphone start together. The take is drawn under the note lanes on one
  shared horizontal timeline (one lane per track, tracks can be hidden or muted) and grows live while
  recording; every take is played back sample-locked with the score, alone or together with it, from
  any point, and exported as WAV. The timeline zooms ¼…8× (buttons, or Ctrl/⌘ + wheel around the
  cursor). «Анализ темпа» compares the take with the notes of a chosen track and marks every note
  that left the tolerance: dashed line where the note belongs, arrow where it was played — red for
  late, blue for early, violet for a note that was never played — plus a tinted band over each
  out-of-tempo stretch, hit rate, mean/worst deviation, drift and a list of slips by bar and beat
  ([`/record`](https://evgenykon.github.io/music-tools/record))

## Getting started

```bash
make build    # build Docker image
make dev      # start dev server at http://localhost:3000
make down     # stop the server
make test     # run chord/tree/notebook/record checks inside the container
```

## Stack

- Nuxt 3 + Vue 3
- Web Audio API (synthesis without external libraries)
- SVG graphics
- Docker

## Development

Commands run inside the Docker container:

```bash
make run cmd="yarn add <package>"
make down && make dev   # restart after adding dependencies
```

- **GTP player:** open Guitar Pro files (.gp3/.gp4/.gp5/.gpx/.gp) or MusicXML and read the score as
  tablature, notation or both; full transport (play/pause, stop, seek, tempo, metronome, loop) and a
  mixer with per-track volume, 10-band EQ and General MIDI instrument choice
  ([`/player`](https://evgenykon.github.io/music-tools/player))

## Sound samples

Guitars and bass use sampled instruments from the FluidR3 GM soundfont
(via [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), MIT);
drums are sampled from the [Tone.js](https://tonejs.github.io/) acoustic kit.
Banks are loaded on demand (~2 MB per instrument) and played through the same
per-track channel as the synthesized instruments, so volume and EQ keep working.
Everything else falls back to the built-in oscillator synthesizer.
