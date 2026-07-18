import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import './wordmark.css'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () =>
        h('span', { class: 'fv-wordmark' }, [
          h('span', { class: 'fv-wordmark__floor' }, 'Floor'),
          h('span', { class: 'fv-wordmark__vote' }, 'Vote'),
        ]),
    })
  },
}
