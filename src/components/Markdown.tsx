import { memo, useMemo, type ReactNode } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { parseBlocks, type Inline } from '@/chat/markdown'
import { radius, space, type, type Palette } from '@/theme'

interface Props {
  source: string
  colors: Palette
  /** Text color role for this bubble. */
  ink: string
  linkColor: string
  codeBackground: string
  /**
   * Her spoken reply was cut off: text after this many visible characters wasn't heard and shows
   * in `fadedInk`. Undefined: nothing is faded.
   */
  fadeFrom?: number
  fadedInk?: string
}

/** Counts visible characters as they render, so text past `fadeFrom` can be faded. */
interface Fade {
  left: number
  ink: string
}

/** A run of text, split where the fade starts. */
function fadeText(text: string, fade: Fade | null, key: string): ReactNode {
  if (!fade || !text) return text
  if (fade.left >= text.length) {
    fade.left -= text.length
    return text
  }
  const heard = fade.left > 0 ? text.slice(0, fade.left) : ''
  fade.left = 0
  const unheard = (
    <Text key={`${key}-f`} style={{ color: fade.ink }}>
      {text.slice(heard.length)}
    </Text>
  )
  return heard ? [heard, unheard] : unheard
}

function renderInlines(inlines: Inline[], props: Props, keyPrefix: string, fade: Fade | null): ReactNode[] {
  return inlines.map((inline, index) => {
    const key = `${keyPrefix}-${index}`
    switch (inline.kind) {
      case 'text':
        return fade ? <Text key={key}>{fadeText(inline.text, fade, key)}</Text> : inline.text
      case 'bold':
        return (
          <Text key={key} style={styles.bold}>
            {renderInlines(inline.children, props, key, fade)}
          </Text>
        )
      case 'italic':
        return (
          <Text key={key} style={styles.italic}>
            {renderInlines(inline.children, props, key, fade)}
          </Text>
        )
      case 'code':
        return (
          <Text key={key} style={[styles.inlineCode, { backgroundColor: props.codeBackground }]}>
            {fadeText(inline.text, fade, key)}
          </Text>
        )
      case 'link':
        return (
          <Text
            key={key}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(inline.url).catch(() => {})}
            style={[styles.link, { color: props.linkColor, textDecorationColor: props.linkColor }]}
          >
            {renderInlines(inline.children, props, key, fade)}
          </Text>
        )
    }
  })
}

/** Her formatting: bold, italics, lists, links (open in the browser), inline code and code blocks. */
export const Markdown = memo(function Markdown(props: Props) {
  const blocks = useMemo(() => parseBlocks(props.source), [props.source])
  const base: TextStyle = { ...(type.bodyLarge as TextStyle), color: props.ink }
  // Fresh per render: it counts characters as the blocks render, in order.
  const fade: Fade | null =
    props.fadeFrom !== undefined && props.fadedInk ? { left: Math.max(0, props.fadeFrom), ink: props.fadedInk } : null
  return (
    <View style={styles.stack}>
      {blocks.map((block, index) => {
        const key = `b${index}`
        switch (block.kind) {
          case 'paragraph':
            return (
              <Text key={key} selectable style={base}>
                {renderInlines(block.inlines, props, key, fade)}
              </Text>
            )
          case 'heading':
            return (
              <Text key={key} selectable accessibilityRole="header" style={[base, styles.bold]}>
                {renderInlines(block.inlines, props, key, fade)}
              </Text>
            )
          case 'list':
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, itemIndex) => {
                  const markerInk = fade && fade.left <= 0 ? fade.ink : block.ordered ? props.ink : props.linkColor
                  return (
                    <View key={`${key}-${itemIndex}`} style={styles.listItem}>
                      <Text style={[base, styles.marker, { color: markerInk }]}>
                        {block.ordered ? `${block.start + itemIndex}.` : '•'}
                      </Text>
                      <Text selectable style={[base, styles.flex]}>
                        {renderInlines(item, props, `${key}-${itemIndex}`, fade)}
                      </Text>
                    </View>
                  )
                })}
              </View>
            )
          case 'code':
            return (
              <ScrollView
                key={key}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[styles.codeBlock, { backgroundColor: props.codeBackground }]}
                contentContainerStyle={styles.codeContent}
              >
                <Text selectable style={[styles.code, { color: props.ink }]}>
                  {fadeText(block.text, fade, key)}
                </Text>
              </ScrollView>
            )
        }
      })}
    </View>
  )
})

const styles = StyleSheet.create({
  stack: { gap: space.sm },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { textDecorationLine: 'underline' },
  inlineCode: { fontFamily: 'monospace', fontSize: 14 },
  list: { gap: 4 },
  listItem: { flexDirection: 'row', gap: space.sm },
  marker: { minWidth: 14 },
  flex: { flex: 1 },
  codeBlock: { borderRadius: radius.field - 4 },
  codeContent: { padding: space.md },
  code: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
})
