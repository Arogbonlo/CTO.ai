import util from 'util';
import { ux, sdk } from '@cto.ai/sdk';
import { exec as oexec } from 'child_process';
import { getWorkspaceOutputs } from './helpers/tfc/index'
const pexec = util.promisify(oexec);

async function run() {

  // make sure terraform config is setup for ephemeral state
  // TODO @kc refactor this to .terraformrc to avoid conflict 
  const tfrc = '/home/ops/.terraform.d/credentials.tfrc.json'
  await pexec(`sed -i 's/{{token}}/${process.env.TFC_TOKEN}/g' ${tfrc}`)
    .catch(e => console.log(e))

  // make sure doctl config is setup for the ephemeral state
  await pexec(`doctl auth init -t ${process.env.DO_TOKEN}`)
    .catch(err => console.log(err))

  const TFC_ORG = process.env.TFC_ORG || ''
  const STACK_TYPE = process.env.STACK_TYPE || 'do-k8s';
  const STACK_TEAM = process.env.OPS_TEAM_NAME || 'private'

  await ux.print(`\n🛠 Loading the ${ux.colors.white(STACK_TYPE)} stack for the ${ux.colors.white(STACK_TEAM)} team...\n`)

  const { STACK_ENV } = await ux.prompt<{
    STACK_ENV: string
  }>({
      type: 'input',
      name: 'STACK_ENV',
      default: 'dev',
      message: 'What is the name of the environment?'
    })

  const { STACK_REPO } = await ux.prompt<{
    STACK_REPO: string
  }>({
      type: 'input',
      name: 'STACK_REPO',
      default: 'sample-app',
      message: 'What is the name of the application repo?'
    })

  const { STACK_TAG } = await ux.prompt<{
    STACK_TAG: string
  }>({
      type: 'input',
      name: 'STACK_TAG',
      default: 'main',
      message: 'What is the name of the tag or branch?'
    })

  const STACKS:any = {
    'dev': [`registry-${STACK_TYPE}`, `${STACK_ENV}-${STACK_TYPE}`, `${STACK_ENV}-${STACK_REPO}-${STACK_TYPE}`],
    'stg': [`registry-${STACK_TYPE}`, `${STACK_ENV}-${STACK_TYPE}`, `${STACK_ENV}-${STACK_REPO}-${STACK_TYPE}`],
    'prd': [`registry-${STACK_TYPE}`, `${STACK_ENV}-${STACK_TYPE}`, `${STACK_ENV}-${STACK_REPO}-${STACK_TYPE}`],
    'all': [
      `registry-${STACK_TYPE}`,
      `dev-${STACK_TYPE}`, 
      `stg-${STACK_TYPE}`,
      `prd-${STACK_TYPE}`,
      `dev-${STACK_REPO}-${STACK_TYPE}`,
      `stg-${STACK_REPO}-${STACK_TYPE}`,
      `stg-${STACK_REPO}-${STACK_TYPE}`
    ]
  }

  if(!STACKS[STACK_ENV].length) {
    return console.log('Please try again with environment set to <dev|stg|prd|all>')
  }

  try {
    console.log(`\n🛰  Attempting to bootstrap ${ux.colors.white(STACK_ENV)} state...`)
    const PREFIX = `${STACK_ENV}_${STACK_TYPE}`.replace(/-/g, '_').toUpperCase()
    const STATE_KEY = `${PREFIX}_STATE`
    const STATE = process.env[`${STATE_KEY}`]

    const outputs = JSON.parse(STATE || '')
    // make sure doctl config is setup for the ephemeral state
    console.log(`\n🔐 Configuring access to ${ux.colors.white(STACK_ENV)} cluster`)
    await pexec(`doctl auth init -t ${process.env.DO_TOKEN}`)
      .catch(err => console.log(err))

    // populate our kubeconfig from doctl into the container
    await exec(`doctl kubernetes cluster kubeconfig save ${outputs.cluster.name} -t ${process.env.DO_TOKEN}`)
      .catch(err => { throw err })

    // confirm we can connect to the cluster to see nodes
    console.log(`\n⚡️ Confirming connection to ${ux.colors.white(outputs.cluster.name)}:`)
      await exec('kubectl get nodes')
        .catch(err => console.log(err))

  } catch(e) {
    console.log(`⚠️  Could not boostrap ${ux.colors.white(STACK_ENV)} state. Proceeding with setup...`)
  }

  console.log('')
  await ux.print(`📦 Deploying ${ux.colors.white(STACK_REPO)}:${ux.colors.white(STACK_TAG)} to ${ux.colors.white(STACK_ENV)} cluster`)
  console.log('')

  // then we build a command to deploy each stack
  const stacks = STACKS[STACK_ENV].map(stack => {
    return  `./node_modules/.bin/cdktf deploy --auto-approve ${stack}`
  })

  await ux.print(`⚙️  Deploying the stack via ${ux.colors.white('Terraform Cloud')} for the ${ux.colors.white(TFC_ORG)} organization...`)
  await exec(stacks.join(' && '), {
    env: { 
      ...process.env, 
      CDKTF_LOG_LEVEL: 'fatal',
      STACK_ENV: STACK_ENV,
      STACK_TYPE: STACK_TYPE, 
      STACK_REPO: STACK_REPO, 
      STACK_TAG: STACK_TAG
    }
  })
  // post processing
  .then(async () => {

    let url = `https://app.terraform.io/app/${TFC_ORG}/workspaces/`
    console.log(`✅ View progress in ${ux.colors.blue(ux.url('Terraform Cloud', url))}.`)

     try {

      console.log(`\n🔒 Syncing infrastructure state with ${ux.colors.white(STACK_TEAM)} team...`)

      // get workspace outputs
      const outputs:any = {}
      await Promise.all(STACKS[STACK_ENV].map(async (stack) => {
        let output = await getWorkspaceOutputs(TFC_ORG, stack, process?.env?.TFC_TOKEN ?? '')
        Object.assign(outputs, output)
      }))

      const CONFIG_KEY = `${STACK_ENV}_${STACK_TYPE}_STATE`.toUpperCase().replace(/-/g,'_')
      // If state doesn't exist, lets bootstrap the cluster
      console.log(`\n✅ Saved the following state in your ${ux.colors.white(STACK_TEAM)} config as ${ux.colors.white(CONFIG_KEY)}:`)
      await sdk.setConfig(CONFIG_KEY, JSON.stringify(outputs))
      console.log(outputs)

      console.log('\n✅ Deployed. Load Balancer is provisioning...')
      console.log(`👀 Check your ${ux.colors.white('Digital Ocean')} dashboard or Lens for status.`)
      console.log(`\n${ux.colors.italic.white('Happy Workflowing!')}\n`)

    } catch (e) {
      console.log('There was an error updating workflow state', e)
      process.exit(1)
    }

  })
  .catch(e => {
    console.log('There was an error deploying the infrastructure.')
    process.exit(1)
  })

}

// custom promisify exec that pipes stdout too
async function exec(cmd, env?: any | null) {
  return new Promise(function(resolve, reject) {
    const child = oexec(cmd, env)
    child?.stdout?.pipe(process.stdout)
    child?.stderr?.pipe(process.stderr)
    child.on('close', (code) => { code ? reject(child.stdout) : resolve(child.stderr) })
  })
}

run()
