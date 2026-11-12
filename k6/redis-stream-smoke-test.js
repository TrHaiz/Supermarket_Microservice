import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  vus: 2,
  duration: '1m',
  thresholds: defaultStreamThresholds,
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

