// @ts-check
import { Readable } from 'stream';
import { Buffer } from 'buffer';
import { Fail, q } from '@agoric/assert';
import BufferLineTransform from '@agoric/internal/src/node/buffer-line-transform.js';
import { createSHA256 } from './hasher.js';

/**
 * @typedef { import('./swingStore').SwingStoreExporter } SwingStoreExporter
 *
 * @typedef {{
 *   initTranscript: (vatID: string) => void,
 *   rolloverSpan: (vatID: string) => number,
 *   rolloverIncarnation: (vatID: string) => number,
 *   getCurrentSpanBounds: (vatID: string) => { startPos: number, endPos: number, hash: string, incarnation: number },
 *   deleteVatTranscripts: (vatID: string) => void,
 *   addItem: (vatID: string, item: string) => void,
 *   readSpan: (vatID: string, startPos?: number) => IterableIterator<string>,
 * }} TranscriptStore
 *
 * @typedef {{
 *   exportSpan: (name: string, includeHistorical: boolean) => AsyncIterableIterator<Uint8Array>
 *   importSpan: (artifactName: string, exporter: SwingStoreExporter, artifactMetadata: Map) => Promise<void>,
 *   getExportRecords: (includeHistorical: boolean) => IterableIterator<readonly [key: string, value: string]>,
 *   getArtifactNames: (includeHistorical: boolean) => AsyncIterableIterator<string>,
 *   readFullVatTranscript: (vatID: string) => Iterable<{position: number, item: string}>
 * }} TranscriptStoreInternal
 *
 * @typedef {{
 *   dumpTranscripts: (includeHistorical?: boolean) => {[vatID: string]: {[position: number]: string}}
 * }} TranscriptStoreDebug
 *
 */

function* empty() {
  // Yield nothing
}

/**
 * @param {number} position
 * @returns {asserts position is number}
 */

function insistTranscriptPosition(position) {
  typeof position === 'number' || Fail`position must be a number`;
  position >= 0 || Fail`position must not be negative`;
}

/**
 * @param {*} db
 * @param {() => void} ensureTxn
 * @param {(key: string, value: string | undefined ) => void} noteExport
 * @param {object} [options]
 * @param {boolean | undefined} [options.keepTranscripts]
 * @returns { TranscriptStore & TranscriptStoreInternal & TranscriptStoreDebug }
 */
export function makeTranscriptStore(
  db,
  ensureTxn,
  noteExport = () => {},
  { keepTranscripts = true } = {},
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptItems (
      vatID TEXT,
      position INTEGER,
      item TEXT,
      incarnation INTEGER,
      PRIMARY KEY (vatID, position)
    )
  `);

  // Transcripts are broken up into "spans", delimited by heap snapshots.  If we
  // take heap snapshots after deliveries 100 and 200, and have not yet
  // performed delivery 201, we'll have two non-current (i.e., isCurrent=null)
  // spans (one with startPos=0, endPos=100, the second with startPos=100,
  // endPos=200), and a single empty isCurrent==1 span with startPos=200 and
  // endPos=200.  After we perform delivery 201, the single isCurrent=1 span
  // will will still have startPos=200 but will now have endPos=201.  For every
  // vatID, there will be exactly one isCurrent=1 span, and zero or more
  // non-current (historical) spans.
  //
  // The transcriptItems associated with historical spans may or may not exist,
  // depending on pruning.  However, the items associated with the current span
  // must always be present

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptSpans (
      vatID TEXT,
      startPos INTEGER, -- inclusive
      endPos INTEGER, -- exclusive
      hash TEXT, -- cumulative hash of this item and previous cumulative hash
      isCurrent INTEGER CHECK (isCurrent = 1),
      incarnation INTEGER,
      PRIMARY KEY (vatID, startPos),
      UNIQUE (vatID, isCurrent)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS currentTranscriptIndex
    ON transcriptSpans (vatID, isCurrent)
  `);

  const sqlDumpItemsQuery = db.prepare(`
    SELECT vatID, position, item
    FROM transcriptItems
    WHERE vatID = ? AND ? <= position AND position < ?
    ORDER BY vatID, position
  `);

  const sqlDumpSpansQuery = db.prepare(`
    SELECT vatID, startPos, endPos, isCurrent, incarnation
    FROM transcriptSpans
    ORDER BY vatID, startPos
  `);

  const sqlDumpVatSpansQuery = db.prepare(`
    SELECT startPos, endPos
    FROM transcriptSpans
    WHERE vatID = ?
    ORDER BY startPos
  `);

  function dumpTranscripts(includeHistorical = true) {
    // debug function to return: dump[vatID][position] = item
    /** @type {Record<string, Record<number, string>>} */
    const transcripts = {};
    for (const spanRow of sqlDumpSpansQuery.iterate()) {
      if (includeHistorical || spanRow.isCurrent) {
        for (const row of sqlDumpItemsQuery.iterate(
          spanRow.vatID,
          spanRow.startPos,
          spanRow.endPos,
        )) {
          const { vatID, position, item } = row;
          if (!transcripts[vatID]) {
            transcripts[vatID] = {};
          }
          transcripts[vatID][position] = item;
        }
      }
    }
    return transcripts;
  }

  function* readFullVatTranscript(vatID) {
    for (const { startPos, endPos } of sqlDumpVatSpansQuery.iterate(vatID)) {
      for (const row of sqlDumpItemsQuery.iterate(vatID, startPos, endPos)) {
        yield row;
      }
    }
  }

  function spanArtifactName(rec) {
    return `transcript.${rec.vatID}.${rec.startPos}.${rec.endPos}`;
  }

  function spanMetadataKey(rec) {
    if (rec.isCurrent) {
      return `transcript.${rec.vatID}.current`;
    } else {
      return `transcript.${rec.vatID}.${rec.startPos}`;
    }
  }

  function spanRec(vatID, startPos, endPos, hash, isCurrent, incarnation) {
    isCurrent = isCurrent ? 1 : 0;
    return { vatID, startPos, endPos, hash, isCurrent, incarnation };
  }

  /**
   * Compute a new cumulative hash for a span that includes a new transcript
   * item.  This is computed by hashing together the hash from the previous item
   * in its span together with the new item's own text.
   *
   * @param {string} priorHash  The previous item's hash
   * @param {string} item  The item itself
   *
   * @returns {string}  The hash of the combined parameters.
   */
  function updateSpanHash(priorHash, item) {
    const itemHash = createSHA256(item).finish();
    return createSHA256(priorHash).add(itemHash).finish();
  }

  /**
   * @type {string} Seed hash to use as the prior hash when computing the hash
   * of the very first item in a span, since it has no prior item to draw upon.
   */
  const initialHash = createSHA256('start of transcript span').finish();

  const sqlWriteSpan = db.prepare(`
    INSERT INTO transcriptSpans
      (vatID, startPos, endPos, hash, isCurrent, incarnation)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  /**
   * Start a new transcript for a given vat
   *
   * @param {string} vatID  The vat whose transcript this shall be
   */
  function initTranscript(vatID) {
    ensureTxn();
    const initialIncarnation = 0;
    sqlWriteSpan.run(vatID, 0, 0, initialHash, 1, initialIncarnation);
    const newRec = spanRec(vatID, 0, 0, initialHash, 1, 0);
    noteExport(spanMetadataKey(newRec), JSON.stringify(newRec));
  }

  const sqlGetCurrentSpanBounds = db.prepare(`
    SELECT startPos, endPos, hash, incarnation
    FROM transcriptSpans
    WHERE vatID = ? AND isCurrent = 1
  `);

  /**
   * Obtain the bounds and other metadata for a vat's current transcript span.
   *
   * @param {string} vatID  The vat in question
   *
   * @returns {{startPos: number, endPos: number, hash: string, incarnation: number}}
   */
  function getCurrentSpanBounds(vatID) {
    const bounds = sqlGetCurrentSpanBounds.get(vatID);
    bounds || Fail`no current transcript for ${q(vatID)}`;
    return bounds;
  }

  const sqlEndCurrentSpan = db.prepare(`
    UPDATE transcriptSpans
    SET isCurrent = null
    WHERE isCurrent = 1 AND vatID = ?
  `);

  const sqlDeleteOldItems = db.prepare(`
    DELETE FROM transcriptItems
    WHERE vatID = ? AND position < ?
  `);

  function doSpanRollover(vatID, isNewIncarnation) {
    ensureTxn();
    const { hash, startPos, endPos, incarnation } = getCurrentSpanBounds(vatID);
    const rec = spanRec(vatID, startPos, endPos, hash, 0, incarnation);
    noteExport(spanMetadataKey(rec), JSON.stringify(rec));
    sqlEndCurrentSpan.run(vatID);
    const incarnationToUse = isNewIncarnation ? incarnation + 1 : incarnation;
    sqlWriteSpan.run(vatID, endPos, endPos, initialHash, 1, incarnationToUse);
    const newRec = spanRec(
      vatID,
      endPos,
      endPos,
      initialHash,
      1,
      incarnationToUse,
    );
    noteExport(spanMetadataKey(newRec), JSON.stringify(newRec));
    if (!keepTranscripts) {
      sqlDeleteOldItems.run(vatID, endPos);
    }
    return incarnationToUse;
  }

  /**
   * End the current transcript span for a vat and start a new span in a new
   * incarnation (e.g., after a vat upgrade).
   *
   * @param {string} vatID  The vat whose transcript is to rollover to a new
   *    span.
   *
   * @returns {number} the new incarnation number
   */
  function rolloverIncarnation(vatID) {
    return doSpanRollover(vatID, true);
  }

  /**
   * End the current transcript span for a vat and start a new span in the
   * current incarnation (e.g., after a heap snapshot event).
   *
   * @param {string} vatID  The vat whose transcript is to rollover to a new
   *    span.
   *
   * @returns {number} the incarnation number
   */
  function rolloverSpan(vatID) {
    return doSpanRollover(vatID, false);
  }

  const sqlDeleteVatSpans = db.prepare(`
    DELETE FROM transcriptSpans
    WHERE vatID = ?
  `);

  const sqlDeleteVatItems = db.prepare(`
    DELETE FROM transcriptItems
    WHERE vatID = ?
  `);

  const sqlGetVatSpans = db.prepare(`
    SELECT vatID, startPos, isCurrent
    FROM transcriptSpans
    WHERE vatID = ?
    ORDER BY startPos
  `);

  /**
   * Delete all transcript data for a given vat (for use when, e.g., a vat is terminated)
   *
   * @param {string} vatID
   */
  function deleteVatTranscripts(vatID) {
    ensureTxn();
    const deletions = sqlGetVatSpans.all(vatID);
    for (const rec of deletions) {
      noteExport(spanMetadataKey(rec), undefined);
    }
    sqlDeleteVatItems.run(vatID);
    sqlDeleteVatSpans.run(vatID);
  }

  const sqlGetAllSpanMetadata = db.prepare(`
    SELECT vatID, startPos, endPos, hash, isCurrent, incarnation
    FROM transcriptSpans
    ORDER BY vatID, startPos
  `);

  const sqlGetCurrentSpanMetadata = db.prepare(`
    SELECT vatID, startPos, endPos, hash, isCurrent, incarnation
    FROM transcriptSpans
    WHERE isCurrent = 1
    ORDER BY vatID, startPos
  `);

  /**
   * Obtain artifact metadata records for spans contained in this store.
   *
   * @param {boolean} includeHistorical  If true, include all metadata that is
   *   present in the store regardless of its currency; if false, only include
   *   the metadata that is part of the swingset's active operational state.
   *
   * Note: in the currently anticipated operational mode, this flag should
   * always be set to `true`, because *all* transcript span metadata is, for
   * now, considered part of the consensus set.  This metadata is being retained
   * as a hedge against possible future need, wherein we find it necessary to
   * replay a vat's entire history from t0 and therefor need to be able to
   * validate historical transcript artifacts that were recovered from external
   * archives rather than retained directly.  While such a need seems highly
   * unlikely, it hypothetically could be forced by some necessary vat upgrade
   * that implicates path-dependent ephemeral state despite our best efforts to
   * avoid having any such state.  However, the flag itself is present in case
   * future operational policy allows for pruning historical transcript span
   * metadata, for example because we've determined that such full-history
   * replay will never be required or because such replay would be prohibitively
   * expensive regardless of need and therefor other repair strategies employed.
   *
   * @yields {readonly [key: string, value: string]}
   * @returns {IterableIterator<readonly [key: string, value: string]>}
   *    An iterator over pairs of [spanMetadataKey, rec], where `rec` is a
   *    JSON-encoded metadata record for the span named by `spanMetadataKey`.
   */
  function* getExportRecords(includeHistorical = true) {
    const sql = includeHistorical
      ? sqlGetAllSpanMetadata
      : sqlGetCurrentSpanMetadata;
    for (const rec of sql.iterate()) {
      const { vatID, startPos, endPos, hash, isCurrent, incarnation } = rec;
      const exportRec = spanRec(
        vatID,
        startPos,
        endPos,
        hash,
        isCurrent,
        incarnation,
      );
      yield [spanMetadataKey(rec), JSON.stringify(exportRec)];
    }
  }

  /**
   * Obtain artifact names for spans contained in this store.
   *
   * @param {boolean} includeHistorical If true, include all spans that are
   * present in the store regardless of their currency; if false, only include
   * the current span for each vat.
   *
   * @yields {string}
   * @returns {AsyncIterableIterator<string>}  An iterator over the names of all the artifacts requested
   */
  async function* getArtifactNames(includeHistorical) {
    const sql = includeHistorical
      ? sqlGetAllSpanMetadata
      : sqlGetCurrentSpanMetadata;
    for (const rec of sql.iterate()) {
      yield spanArtifactName(rec);
    }
  }

  const sqlGetSpanEndPos = db.prepare(`
    SELECT endPos
    FROM transcriptSpans
    WHERE vatID = ? AND startPos = ?
  `);
  sqlGetSpanEndPos.pluck(true);

  const sqlReadSpanItems = db.prepare(`
    SELECT item
    FROM transcriptItems
    WHERE vatID = ? AND ? <= position AND position < ?
    ORDER BY position
  `);

  /**
   * Read the items in a transcript span
   *
   * @param {string} vatID  The vat whose transcript is being read
   * @param {number} [startPos] A start position identifying the span to be
   *    read; defaults to the current span, whatever it is
   *
   * @returns {IterableIterator<string>}  An iterator over the items in the indicated span
   */
  function readSpan(vatID, startPos) {
    /** @type {number | undefined} */
    let endPos;
    if (startPos === undefined) {
      ({ startPos, endPos } = getCurrentSpanBounds(vatID));
    } else {
      insistTranscriptPosition(startPos);
      endPos = sqlGetSpanEndPos.get(vatID, startPos);
      if (typeof endPos !== 'number') {
        throw Fail`no transcript span for ${q(vatID)} at ${q(startPos)}`;
      }
    }
    startPos <= endPos || Fail`${q(startPos)} <= ${q(endPos)}}`;

    function* reader() {
      for (const { item } of sqlReadSpanItems.iterate(
        vatID,
        startPos,
        endPos,
      )) {
        yield item;
      }
    }

    if (startPos === endPos) {
      return empty();
    }

    return reader();
  }

  const sqlGetSpanIsCurrent = db.prepare(`
    SELECT isCurrent
    FROM transcriptSpans
    WHERE vatID = ? AND startPos = ?
  `);
  sqlGetSpanIsCurrent.pluck(true);

  /**
   * Read a transcript span and return it as a stream of data suitable for
   * export to another store.  Transcript items are terminated by newlines.
   *
   * Transcript span artifact names should be strings of the form:
   *   `transcript.${vatID}.${startPos}.${endPos}`
   *
   * @param {string} name  The name of the transcript artifact to be read
   * @param {boolean} includeHistorical  If true, allow non-current spans to be fetched
   *
   * @returns {AsyncIterableIterator<Uint8Array>}
   * @yields {Uint8Array}
   */
  async function* exportSpan(name, includeHistorical) {
    typeof name === 'string' || Fail`artifact name must be a string`;
    const parts = name.split('.');
    const [type, vatID, pos] = parts;
    // prettier-ignore
    (parts.length === 4 && type === 'transcript') ||
      Fail`expected artifact name of the form 'transcript.{vatID}.{startPos}.{endPos}', saw ${q(name)}`;
    const isCurrent = sqlGetSpanIsCurrent.get(vatID, pos);
    isCurrent !== undefined || Fail`transcript span ${q(name)} not available`;
    isCurrent ||
      includeHistorical ||
      Fail`transcript span ${q(name)} not available`;
    const startPos = Number(pos);
    for (const entry of readSpan(vatID, startPos)) {
      yield Buffer.from(`${entry}\n`);
    }
  }

  const sqlAddItem = db.prepare(`
    INSERT INTO transcriptItems (vatID, item, position, incarnation)
    VALUES (?, ?, ?, ?)
  `);

  const sqlUpdateSpan = db.prepare(`
    UPDATE transcriptSpans
    SET endPos = ?, hash = ?
    WHERE vatID = ? AND isCurrent = 1
  `);

  /**
   * Append an item to the current transcript span for a given vat
   *
   * @param {string} vatID  The whose transcript is being added to
   * @param {string} item  The item to add
   */
  const addItem = (vatID, item) => {
    ensureTxn();
    const { startPos, endPos, hash, incarnation } = getCurrentSpanBounds(vatID);
    sqlAddItem.run(vatID, item, endPos, incarnation);
    const newEndPos = endPos + 1;
    const newHash = updateSpanHash(hash, item);
    sqlUpdateSpan.run(newEndPos, newHash, vatID);
    const rec = spanRec(vatID, startPos, newEndPos, newHash, 1, incarnation);
    noteExport(spanMetadataKey(rec), JSON.stringify(rec));
  };

  /**
   * Import a transcript span from another store.
   *
   * @param {string} name  Artifact Name of the transcript span
   * @param {SwingStoreExporter} exporter  Exporter from which to get the span data
   * @param {object} info  Metadata describing the span
   *
   * @returns {Promise<void>}
   */
  async function importSpan(name, exporter, info) {
    const parts = name.split('.');
    const [type, vatID, rawStartPos, rawEndPos] = parts;
    // prettier-ignore
    parts.length === 4 && type === 'transcript' ||
      Fail`expected artifact name of the form 'transcript.{vatID}.{startPos}.{endPos}', saw '${q(name)}'`;
    // prettier-ignore
    info.vatID === vatID ||
      Fail`artifact name says vatID ${q(vatID)}, metadata says ${q(info.vatID)}`;
    const startPos = Number(rawStartPos);
    // prettier-ignore
    info.startPos === startPos ||
      Fail`artifact name says startPos ${q(startPos)}, metadata says ${q(info.startPos)}`;
    const endPos = Number(rawEndPos);
    // prettier-ignore
    info.endPos === endPos ||
      Fail`artifact name says endPos ${q(endPos)}, metadata says ${q(info.endPos)}`;
    const artifactChunks = exporter.getArtifact(name);
    const inStream = Readable.from(artifactChunks);
    const lineTransform = new BufferLineTransform();
    const lineStream = inStream.pipe(lineTransform).setEncoding('utf8');
    let hash = initialHash;
    let pos = startPos;
    for await (const line of lineStream) {
      const item = line.trimEnd();
      sqlAddItem.run(vatID, item, pos, info.incarnation);
      hash = updateSpanHash(hash, item);
      pos += 1;
    }
    pos === endPos || Fail`artifact ${name} is not available`;
    info.hash === hash ||
      Fail`artifact ${name} hash is ${q(hash)}, metadata says ${q(info.hash)}`;
    sqlWriteSpan.run(
      info.vatID,
      info.startPos,
      info.endPos,
      info.hash,
      info.isCurrent ? 1 : null,
      info.incarnation,
    );
  }

  return harden({
    initTranscript,
    rolloverSpan,
    rolloverIncarnation,
    getCurrentSpanBounds,
    addItem,
    readSpan,
    deleteVatTranscripts,

    exportSpan,
    importSpan,
    getExportRecords,
    getArtifactNames,

    dumpTranscripts,
    readFullVatTranscript,
  });
}
