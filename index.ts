import { Stack } from './src/stack/index';

const STACK_ENV = process.env.STACK_ENV || 'dev'
const STACK_TYPE = process.env.STACK_TYPE || 'do-k8s'
const STACK_REPO = process.env.STACK_REPO || 'sample-app'
const STACK_TAG = process.env.STACK_TAG || 'main'

async function run() {

  new Stack({
    repo: STACK_REPO,
    tag: STACK_TAG,
    key: STACK_TYPE
  });

}

run()
