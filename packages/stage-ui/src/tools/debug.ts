import { tool } from '@xsai/tool'
import { strictObject } from 'valibot'

const tools = [
  tool({
    name: 'builtIn_debugRandomNumber',
    description: 'Generate a random number between 0 and 1',
    execute: async () => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(Math.random().toString())
        }, 1000)
      })
    },
    parameters: strictObject({}),
  }),
]

export const debug = async () => Promise.all(tools)
