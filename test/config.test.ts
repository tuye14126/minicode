import { MiniCodeSettings, saveMiniCodeSettings } from '../src/config'

const updated: MiniCodeSettings = {
  maxOutPutTokens: 99999,
  env: {
    test: 'abc'
  }
}

saveMiniCodeSettings(updated)