import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { rankProfile } from '../lib/localMemory/memoryProfile';
import type { Fact } from '../lib/localMemory/memoryCore';
import { useLocalMemory } from '../lib/localMemorySession';

const labels: Record<string, string> = {
  'home.city': 'Residenza', 'pet.name': 'Nome dell’animale', 'hobby.music': 'Strumento musicale',
};

export default function LocalMemoriesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const memory = useLocalMemory();
  if (!memory.ready) return (
    <View style={[styles.root, {paddingTop: insets.top + 16}]}>
      <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.action}>Indietro</Text></Pressable>
      <Text style={styles.copy}>Archivio locale non disponibile.</Text>
    </View>
  );
  return <MemoryEditor />;
}

function MemoryEditor() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const memory = useLocalMemory();
  const [saving, setSaving] = useState(false);
  const [recovery, setRecovery] = useState('');
  const [restore, setRestore] = useState(false);
  const [exportKey, setExportKey] = useState('');
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState<{fact: Fact; value: string} | null>(null);
  const ranked = query.trim() ? rankProfile(memory.facts, query) : null;
  const shown = ranked
    ? ranked.flatMap(key => memory.facts.find(fact => fact.key === key) ?? [])
    : memory.facts;

  async function apply(action: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    try {
      await action();
    } catch {
      Alert.alert('Modifica non applicata', 'Il ricordo è cambiato oppure l’archivio non è disponibile.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={{paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24}}>
      <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.action}>Indietro</Text></Pressable>
      <Text style={styles.title}>Ricordi sul dispositivo</Text>
      {memory.ready && !memory.pending.length && !memory.facts.length && <Text style={styles.copy}>Nessun ricordo salvato.</Text>}
      {memory.pending.map(change => {
        const existing = memory.facts.find(fact => fact.key === change.key);
        return (
          <View key={change.key} style={styles.card}>
            <Text style={styles.copy}>{labels[change.key] ?? change.key}</Text>
            <Text style={styles.value}>{change.value}</Text>
            <Pressable accessibilityRole="button" disabled={saving} onPress={() => void apply(() => memory.confirm(change))}>
              <Text style={styles.action}>{existing ? 'Conferma correzione' : 'Salva sul dispositivo'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={saving} onPress={() => memory.dismiss(change)}>
              <Text style={styles.action}>Scarta proposta</Text>
            </Pressable>
          </View>
        );
      })}
      {memory.ready && (
        <Pressable accessibilityRole="button" disabled={saving} onPress={() => void apply(memory.loadLegacy)}>
          <Text style={styles.action}>Cerca ricordi da importare</Text>
        </Pressable>
      )}
      {memory.legacy.map(item => (
        <View key={item.key} style={styles.card}>
          <Text style={styles.copy}>Ricordo precedente</Text>
          <Text style={styles.value}>{item.value}</Text>
          <Pressable accessibilityRole="button" disabled={saving} onPress={() => Alert.alert(
            'Importare questo ricordo?', undefined,
            [{text: 'Annulla', style: 'cancel'}, {text: 'Importa', onPress: () => void apply(() => memory.importLegacy(item))}],
          )}>
            <Text style={styles.action}>Importa sul dispositivo</Text>
          </Pressable>
        </View>
      ))}
      <Pressable accessibilityRole="button" disabled={saving} onPress={() => void apply(async () => {
        const key = await memory.exportFile();
        setExportKey(key);
      })}><Text style={styles.action}>Esporta backup cifrato</Text></Pressable>
      {!!exportKey && <View style={styles.card}>
        <Text style={styles.copy}>Conserva questa chiave separatamente dal file. Serve per ripristinare il backup.</Text>
        <Text selectable style={styles.value}>{exportKey}</Text>
        <Pressable onPress={() => setExportKey('')}><Text style={styles.action}>Ho conservato la chiave</Text></Pressable>
      </View>}
      {!memory.facts.length && !restore && <Pressable disabled={saving} onPress={() => setRestore(true)}>
        <Text style={styles.action}>Ripristina un backup</Text>
      </Pressable>}
      {restore && <View style={styles.card}>
        <Text style={styles.copy}>Inserisci la chiave del backup e seleziona il file. Il ripristino richiede un archivio vuoto dello stesso account.</Text>
        <TextInput accessibilityLabel="Chiave del backup" secureTextEntry value={recovery}
          onChangeText={setRecovery} autoCapitalize="none" autoCorrect={false} autoComplete="off" style={styles.value} />
        <Pressable disabled={saving || !recovery.trim()} onPress={() => void apply(async () => {
          await memory.restoreFile(recovery);
          setRecovery('');
          setRestore(false);
          Alert.alert('Backup ripristinato');
        })}><Text style={styles.action}>Seleziona file e ripristina</Text></Pressable>
        <Pressable disabled={saving} onPress={() => {setRecovery(''); setRestore(false);}}>
          <Text style={styles.action}>Annulla</Text>
        </Pressable>
      </View>}
      {!!memory.facts.length && (
        <TextInput accessibilityLabel="Cerca nei ricordi locali" value={query} onChangeText={setQuery}
          placeholder="Cerca nei ricordi" placeholderTextColor="#94a3b8" style={[styles.value, styles.card]}
          autoCorrect={false} autoComplete="off" />
      )}
      {ranked && !shown.length && <Text style={styles.copy}>Nessun ricordo pertinente.</Text>}
      {shown.map(fact => (
        <View key={fact.key} style={styles.card}>
          <Text style={styles.copy}>{labels[fact.key] ?? (fact.key.startsWith('legacy.note.') ? 'Ricordo importato' : fact.key)}</Text>
          {edit?.fact === fact ? (
            <View>
              <TextInput value={edit.value} accessibilityLabel="Correzione del ricordo"
                onChangeText={value => setEdit({fact, value})} maxLength={4000}
                autoCorrect={false} spellCheck={false} autoComplete="off"
                editable={!saving} multiline style={styles.value} />
              <Pressable accessibilityRole="button" disabled={saving || !edit.value.trim()}
                onPress={() => void apply(async () => {
                  await memory.correct(fact, edit.value);
                  setEdit(null);
                })}><Text style={styles.action}>Salva correzione</Text></Pressable>
              <Pressable accessibilityRole="button" disabled={saving} onPress={() => setEdit(null)}>
                <Text style={styles.action}>Annulla</Text>
              </Pressable>
            </View>
          ) : (
            <View>
              <Text style={styles.value}>{fact.value}</Text>
              <Pressable accessibilityRole="button" disabled={saving} onPress={() => setEdit({fact, value: fact.value})}>
                <Text style={styles.action}>Correggi</Text>
              </Pressable>
            </View>
          )}
          <Pressable accessibilityRole="button" disabled={saving} onPress={() => Alert.alert(
            'Cancellare questo ricordo?', undefined,
            [{text: 'Annulla', style: 'cancel'}, {text: 'Cancella', style: 'destructive', onPress: () => void apply(() => memory.forget(fact))}],
          )}>
            <Text style={styles.action}>Cancella</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, paddingHorizontal: 22, backgroundColor: '#0c1220'},
  title: {color: '#f1f5f9', fontSize: 25, fontWeight: '600', marginVertical: 16},
  copy: {color: '#cbd5e1', fontSize: 15},
  value: {color: '#f1f5f9', fontSize: 18, marginVertical: 6},
  action: {color: '#bfdbfe', paddingVertical: 10, fontSize: 16},
  card: {backgroundColor: '#172234', padding: 14, borderRadius: 12, marginTop: 12},
});
