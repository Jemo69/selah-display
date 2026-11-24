import RegularOutput from './RegularOutput';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StreamOutput');

/**
 * Live-stream overlay route (/stream).
 *
 * The output renders only a transparent bottom band by default, so it can be
 * added to OBS/vMix over the camera without taking the preacher's frame.
 */
const StreamOutput = () => {
  logger.info('StreamOutput mounted');
  return <RegularOutput outputKey="stream" displayName="Stream" />;
};

export default StreamOutput;
