/**
 * HandsFreeOrb — piccolo orb con arco verde fluido lungo il perimetro
 * (Fabio 2026-08-12, rifinitura 2026-08-12b).
 *
 * Nuovo controllo di modalità conversazione:
 *   • AUTOMATICO (default)  → orb verde scuro desaturato + glow tenue
 *                             + arco verde più brillante che scorre lento
 *                             sul bordo. Orb e arco sono percepiti come
 *                             UN UNICO controllo attivo.
 *   • MANUALE               → orb neutro/grigio, nessun verde, nessun
 *                             movimento, nessun glow.
 *
 * Deve rimanere sempre discreto — non è protagonista dell'header,
 * l'eclisse centrale sì.
 *
 * Design brief (letterale):
 *   - Non è uno spinner/loader. Non ruota l'intero orb.
 *   - È SOLO l'arco verde che scorre lungo la circonferenza.
 *   - Movimento estremamente fluido, lento, continuo, no scatti, no pause,
 *     no quattro posizioni distinte.
 *   - Verde = stesso #34D399 già in uso oggi per hands-free attivo.
 *   - Concetto visivo: "Koda è ferma, l'automatismo scorre".
 *
 * Implementazione:
 *   - Svg con tre layer:
 *       (1) Cerchio glow esterno (solo automatico, opacità ~0.14)
 *       (2) Cerchio corpo orb (verde scuro desaturato o grigio neutro)
 *       (3) Arco stroke (~90°) verde brillante, ruotato via Animated.Value
 *   - Loop lineare in 4s per giro → percezione lenta e continua senza scatti.
 *   - useNativeDriver: true → l'animazione gira sul thread native, zero jank.
 *   - Quando `active === false` la rotazione è comunque montata ma l'arco
 *     è nascosto (opacità 0) → nessun reset di fase quando si riattiva.
 */
import React, { useEffect, useRef } from "react";
import { Animated, Easing, View, StyleSheet } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

type Props = {
  /** true = modalità automatica (default) → arco visibile e scorre.
   *  false = modalità manuale → orb fermo, nessun arco verde. */
  active: boolean;
  /** Diametro totale del componente in px. Default 24 (compact per header). */
  size?: number;
  /** Colore verde dell'arco. Default #34D399 (stesso usato oggi per hands-free). */
  arcColor?: string;
  /** Colore del corpo dell'orb in modalità MANUALE (neutro, no verde). */
  orbColorInactive?: string;
  /** Colore del corpo dell'orb in modalità AUTOMATICA — verde scuro/desaturato,
   *  coerente con arcColor ma NON brillante. Fabio 2026-08-12: l'orb deve
   *  essere percepito come tutt'uno con l'arco, non come cerchio grigio con
   *  arco appoggiato sopra. */
  orbColorActive?: string;
  /** Colore del glow verde leggero attorno all'orb in modalità automatica.
   *  Molto tenue — deve solo unificare orb+arco, non richiamare l'attenzione. */
  glowColor?: string;
};

const AnimatedSvg = Animated.createAnimatedComponent(Svg);

export default function HandsFreeOrb({
  active,
  size = 24,
  arcColor = "#34D399",
  orbColorInactive = "rgba(255,255,255,0.18)",
  // Verde scuro desaturato — stessa tinta di #34D399 ma con luminanza bassa.
  // NON deve essere un pallino verde brillante: qui l'orb resta discreto.
  orbColorActive = "rgba(52, 211, 153, 0.28)",
  // Glow più tenue ancora — appena sufficiente a legare visivamente arco+corpo.
  glowColor = "rgba(52, 211, 153, 0.14)",
}: Props) {
  // Loop di rotazione continuo. Duration = 4000ms → 1 giro ogni 4 secondi.
  // Percezione lenta e fluida. Il valore va da 0 a 1, poi restart senza reset
  // visibile grazie a Easing.linear.
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Avviamo il loop una sola volta al mount. La visibilità dell'arco è
    // gestita da opacità (vedi sotto), NON dallo start/stop dell'animazione:
    // così quando l'utente passa avanti/indietro tra automatico e manuale
    // NON c'è ripartenza brusca — la fase resta coerente e il flusso continua.
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 4000, // giro ogni 4s — lento, fluido
        easing: Easing.linear, // linear = flusso costante, no accelerazioni
        useNativeDriver: true,
        isInteraction: false, // non blocca gestures
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [rotation]);

  const rotate = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const cx = size / 2;
  const cy = size / 2;
  // Raggio del corpo orb (leggermente < della metà per lasciare spazio
  // all'arco stroke che gira sul bordo esterno)
  const orbRadius = size * 0.32;
  // Raggio del cerchio su cui viaggia l'arco (esterno al corpo)
  const arcRadius = size * 0.44;
  // Arco = ~90° della circonferenza (quarto). Punto iniziale in alto (12 o'clock).
  // Path: M x1 y1 A r r 0 0 1 x2 y2 (arco corto in senso orario)
  const arcStart = { x: cx, y: cy - arcRadius }; // top
  const arcEndAngle = -Math.PI / 2 + Math.PI / 2; // 90° rotato = 3 o'clock
  const arcEnd = {
    x: cx + arcRadius * Math.cos(arcEndAngle),
    y: cy + arcRadius * Math.sin(arcEndAngle),
  };
  const arcPath = `M ${arcStart.x} ${arcStart.y} A ${arcRadius} ${arcRadius} 0 0 1 ${arcEnd.x} ${arcEnd.y}`;

  // Raggio del glow esterno (leggermente più grande dell'orb, opacità bassa,
  // solo in modalità automatica). Funziona anche su Android senza filtri
  // esotici perché è semplicemente un Circle grande e semitrasparente.
  const glowRadius = size * 0.42;

  // Colore effettivo del corpo dell'orb in base allo stato.
  // Automatico → verde scuro desaturato (unificato con l'arco).
  // Manuale    → grigio neutro (nessun verde).
  const currentOrbColor = active ? orbColorActive : orbColorInactive;

  return (
    <View style={[styles.container, { width: size, height: size }]} pointerEvents="none">
      {/* Base: glow verde tenue (solo in automatico) + corpo orb.
          Sono nello stesso Svg per compositing pulito, nessun jitter. */}
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        {active && (
          <Circle cx={cx} cy={cy} r={glowRadius} fill={glowColor} />
        )}
        <Circle cx={cx} cy={cy} r={orbRadius} fill={currentOrbColor} />
      </Svg>
      {/* Arco animato (ruota SOLO lui, orb sotto resta fermo).
          Visibilità gestita da opacità così l'animazione non riparte
          quando si passa da automatico a manuale e viceversa. */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [{ rotate }],
            opacity: active ? 1 : 0,
          },
        ]}
        pointerEvents="none"
      >
        <AnimatedSvg width={size} height={size}>
          <Path
            d={arcPath}
            stroke={arcColor}
            strokeWidth={size * 0.09}
            strokeLinecap="round"
            fill="none"
          />
        </AnimatedSvg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
});
