import type { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { SomfySmartPlatform } from './platform';

/** Homebridge entry point. */
export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, SomfySmartPlatform);
};
