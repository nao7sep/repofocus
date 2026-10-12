import { parentPort } from 'node:worker_threads';
import { compileAlwaysShowConfiguration, type AlwaysShowConfiguration } from './alwaysShow';
import type { AlwaysShowWorkerRequest, AlwaysShowWorkerResponse } from './alwaysShowWorkerProtocol';

let configuration: AlwaysShowConfiguration | undefined;
parentPort!.on('message', (request: AlwaysShowWorkerRequest) => {
  let response: AlwaysShowWorkerResponse;
  try {
    if (request.kind === 'configure') {
      configuration = compileAlwaysShowConfiguration(request.patterns);
      response = { kind: 'ready' };
    } else {
      if (!configuration) throw new Error('Always-show matching started before configuration.');
      response = { kind: 'match', matches: configuration.matches(request.path) };
    }
  } catch (error) {
    const diagnostic = error instanceof Error ? error : new Error(String(error));
    response = {
      kind: 'failure',
      error: { name: diagnostic.name, message: diagnostic.message, stack: diagnostic.stack },
    };
  }
  parentPort!.postMessage(response);
});
