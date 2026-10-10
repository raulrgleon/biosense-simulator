# Continuidad entre agentes — BioSense — simulador

Estas instrucciones aplican a Codex, Antigravity y cualquier agente que trabaje sobre este repositorio. No sustituyen las indicaciones del usuario ni las guías específicas del framework.

## Inicio de cada sesión
1. Leer `HANDOFF.md`, este archivo y la documentación del proyecto pertinente.
2. Determinar el directorio real, la rama, el commit y los cambios sin guardar mediante `git status --short` y `git rev-parse --short HEAD`. No asumir que el árbol está limpio.
3. Revisar código, pruebas y dependencias reales antes de tomar decisiones. Distinguir lo verificado de lo documentado, inferido o pendiente.
4. Si el entorno tiene autorización para leer la memoria global privada, consultar únicamente el contexto relacionado (projects/biosense/CONTEXT.md) y no toda la biblioteca. Si no tiene acceso, continuar con este repositorio sin inventar memoria.

## Checkpoints durante el trabajo
1. Después de cada bloque funcional terminado o prueba significativa, actualizar `HANDOFF.md` con objetivo, cambios y archivos afectados, pruebas y resultado **real**, bloqueos y **siguiente paso concreto**.
2. Actualizar el checkpoint antes de operaciones importantes, de grandes refactors o al prever un cambio de agente / agotamiento de tokens. No prometer puntos de control por tiempo si el agente no puede garantizar un temporizador.
3. Mantener `HANDOFF.md` breve y actualizado; no reemplazar pruebas o historial Git por recuerdos del chat. Registrar rama/commit y si hay trabajo local sin commit.
4. Al cerrar una sesión, resumir en `HANDOFF.md` qué se hizo, qué no se hizo y lo que debe hacer el siguiente agente. **No** dar por publicado el estado si los cambios son solo locales.

## Transferencia Codex ↔ Antigravity ↔ otros
1. El siguiente agente lee `AGENTS.md` y `HANDOFF.md`, comprueba `git status`, examina los cambios existentes y ejecuta solo las pruebas pertinentes.
2. Proteger cambios del agente anterior. No ejecutar `git reset`, `git clean`, `git checkout -- .`, sobrescrituras masivas ni acciones destructivas para “arreglar” el entorno sin aprobación explícita.
3. Si ambos agentes trabajan a la vez, usar ramas/worktrees separados o coordinar para impedir conflictos. No reescribir `HANDOFF.md` mientras otro agente lo edita.
4. Compartir carpeta local sirve en el mismo iMac. Para saltar a un entorno cloud, los cambios deben estar accesibles mediante rama/commit u otro traspaso autorizado; un archivo local por sí solo no aparece en la nube.
5. La interrupción por cuotas/tokens **no** ejecuta automáticamente otro agente. Los checkpoints permiten recuperar el último estado registrado; comprobar también los archivos posteriores a él.

## Seguridad y autorización
- No subir secretos, claves, tokens, contraseñas, datos de clientes ni información personal sensible al código, memoria o logs.
- No publicar, hacer push, desplegar, borrar información ni modificar la memoria global sin autorización expresa del usuario. Crear/actualizar `HANDOFF.md` dentro de una tarea de desarrollo autorizada forma parte de este flujo, pero no concede permiso para hacer push.
- Evitar leer o enviar archivos ajenos al proyecto. Nunca inventar pruebas, compilaciones, despliegues o estados productivos.
