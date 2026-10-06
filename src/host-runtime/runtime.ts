import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as Zod from 'zod'
import * as Sdk from '@jaspers-ai/sdk'
import { boot } from './boot'

// Everything a plugin view's iframe borrows from the app, in one bundle: React, zod, the SDK, and
// the script that mounts the view. One bundle is the point — the iframe's import map sends every
// bare name in the plugin's own bundle to a shim that re-exports one of these namespaces, so the
// plugin and the SDK hooks under it share one React instance. Built by
// scripts/build-host-runtime.mjs into out/host-runtime, served over jaspers-host://runtime/.

export { React, JsxRuntime, ReactDOM, ReactDOMClient, Zod, Sdk, boot }
