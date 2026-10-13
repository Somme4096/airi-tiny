import { portableProviderDefinitions } from '@proj-airi/provider-inference'

import { registerProviders } from './registry'

import './aliyun-nls'
import './apple-speech'
import './apple-vision'
import './sherpaw'
import './local-audio'
import './kokoro-local'
import './nvidia'
import './prompt-api'

registerProviders(portableProviderDefinitions)

export {
  getDefinedProvider,
  isProviderId,
  listProviders,
} from './registry'

export type { StageProviderId } from './registry'
