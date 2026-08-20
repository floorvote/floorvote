import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import './wordmark.css'
import './footer.css'
import { LOGO_MARK } from '../../../shared/logo'
import { PRODUCT_NAME_WORDMARK } from '../../../shared/brand'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      // The brand lockup: hemicycle mark + wordmark. Mark geometry and the
      // "Floor"/"Vote" split come from the single sources (shared/logo, shared/brand).
      'nav-bar-title-before': () =>
        h('span', { class: 'fv-wordmark' }, [
          h(
            'svg',
            {
              class: 'fv-wordmark__mark',
              viewBox: LOGO_MARK.inlineViewBox,
              fill: '#e8a33d',
              'aria-hidden': 'true',
            },
            LOGO_MARK.paths.map((d) => h('path', { d })),
          ),
          h('span', {}, [
            h('span', { class: 'fv-wordmark__floor' }, PRODUCT_NAME_WORDMARK.primary),
            h('span', { class: 'fv-wordmark__vote' }, PRODUCT_NAME_WORDMARK.accent),
          ]),
        ]),
    })
  },
}
