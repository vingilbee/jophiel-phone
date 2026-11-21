import { memo, useMemo } from 'react'
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
}

function renderInlines(inlines: Inline[], props: Props, keyPrefix: string): React.ReactNode[] {
  return inlines.map((inline, index) => {
    const key = `${keyPrefix}-${index}`
    switch (inline.kind) {
      case 'text':
        return inline.text
      case 'bold':
        return (
          <Text key={key} style={styles.bold}>
            {renderInlines(inline.children, props, key)}
          </Text>
        )
      case 'italic':
        return (
          <Text key={key} style={styles.italic}>
            {renderInlines(inline.children, props, key)}
          </Text>
        )
      case 'code':
        return (
          <Text key={key} style={[styles.inlineCode, { backgroundColor: props.codeBackground }]}>
            {inline.text}
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
            {renderInlines(inline.children, props, key)}
          </Text>
        )
    }
  })
}

/** Her formatting: bold, italics, lists, links (open in the browser), inline code and code blocks. */
export const Markdown = memo(function Markdown(props: Props) {
  const blocks = useMemo(() => parseBlocks(props.source), [props.source])
  const base: TextStyle = { ...(type.bodyLarge as TextStyle), color: props.ink }
  return (
    <View style={styles.stack}>
      {blocks.map((block, index) => {
        const key = `b${index}`
        switch (block.kind) {
          case 'paragraph':
            return (
              <Text key={key} selectable style={base}>
                {renderInlines(block.inlines, props, key)}
              </Text>
            )
          case 'heading':
            return (
              <Text key={key} selectable accessibilityRole="header" style={[base, styles.bold]}>
                {renderInlines(block.inlines, props, key)}
              </Text>
            )
          case 'list':
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, itemIndex) => (
                  <View key={`${key}-${itemIndex}`} style={styles.listItem}>
                    <Text style={[base, styles.marker, { color: block.ordered ? props.ink : props.linkColor }]}>
                      {block.ordered ? `${block.start + itemIndex}.` : '•'}
                    </Text>
                    <Text selectable style={[base, styles.flex]}>
                      {renderInlines(item, props, `${key}-${itemIndex}`)}
                    </Text>
                  </View>
                ))}
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
                  {block.text}
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
