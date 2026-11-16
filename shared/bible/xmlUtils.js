import createSharedLogger from '../logger.js';

const log = createSharedLogger('BibleXML');

let parser = null;

async function loadParser() {
  try {
    const mod = await import('fast-xml-parser');
    return mod.XMLParser || mod.default?.XMLParser || mod.default || null;
  } catch {}

  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      const path = await import('path');
      const { fileURLToPath, pathToFileURL } = await import('url');
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const baseCandidates = [
        path.join(currentDir, '../../server/node_modules/fast-xml-parser'),
        path.join(currentDir, '../node_modules/fast-xml-parser'),
        path.join(currentDir, '../../node_modules/fast-xml-parser'),
      ];
      if (process.resourcesPath) {
        baseCandidates.push(
          path.join(process.resourcesPath, 'app.asar.unpacked/server/node_modules/fast-xml-parser'),
          path.join(process.resourcesPath, 'app.asar.unpacked/node_modules/fast-xml-parser')
        );
      }
      const candidates = [];
      for (const base of baseCandidates) {
        candidates.push(path.join(base, 'src/fxp.js'));
        candidates.push(base);
      }
      for (const cand of candidates) {
        try {
          const mod = await import(/* @vite-ignore */ pathToFileURL(cand).href);
          const P = mod.XMLParser || mod.default?.XMLParser || mod.default;
          if (P) return P;
        } catch {}
      }
    } catch {}
  }
  return null;
}

try {
  const XMLParser = await loadParser();
  if (XMLParser) {
    parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      ignoreDeclaration: true,
      parseAttributeValue: true,
      parseTagValue: true,
      trimValues: true
    });
  } else {
    log.warn('fast-xml-parser not available, bible XML parsing disabled');
  }
} catch (e) {
  log.warn('Failed to load fast-xml-parser:', e?.message);
  parser = null;
}

export function xml2json(xml) {
  if (!parser) {
    log.warn('xml2json called but parser unavailable');
    return null;
  }
  log.debug(`xml2json: parsing XML, length=${xml?.length || 0}`);
  try {
    return parser.parse(xml);
  } catch (e) {
    log.error('XML parsing error:', e);
    return null;
  }
}

export function detectBibleFormat(content) {
  const trimmed = (content || '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      const keys = Object.keys(data || {}).filter((k) => k !== 'Info');
      const looksLikeGateway = keys.some((book) => {
        const chapters = data[book];
        return chapters && typeof chapters === 'object' && Object.values(chapters).some((verses) => verses && typeof verses === 'object');
      });
      if (looksLikeGateway) {
        log.debug('detectBibleFormat: detected gatewayJson format');
        return 'gatewayJson';
      }
    } catch {}
  }
  if (content.includes('XMLBIBLE') && content.includes('BIBLEBOOK')) {
    log.debug('detectBibleFormat: detected zefania format');
    return 'zefania';
  }
  if (content.includes('osisText') && content.includes('osisID')) {
    log.debug('detectBibleFormat: detected osis format');
    return 'osis';
  }
  if (content.includes('bible') && content.includes('b n=') && content.includes('v n=')) {
    log.debug('detectBibleFormat: detected opensong format');
    return 'opensong';
  }
  if (content.includes('bible') && content.includes('verse number=')) {
    log.debug('detectBibleFormat: detected beblia format');
    return 'beblia';
  }
  
  log.debug('detectBibleFormat: format unknown');
  return 'unknown';
}
