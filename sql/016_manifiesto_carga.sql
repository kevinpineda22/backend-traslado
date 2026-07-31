-- =============================================================================
-- Migration 016: MANIFIESTO DE CARGA
-- Ejecutar en el SQL Editor de Supabase (una sola vez), ANTES de desplegar.
--
-- QUÉ CAMBIA EN EL FLUJO
-- Hoy el despachador firma y el despacho pasa a `Recolectado` de una: ahí salen
-- los correos, corre la auto-clasificación del flujo llano y se sube el plano a
-- SIESA. El problema es que ese momento NO es cuando el camión sale — es cuando
-- el despachador terminó de contar.
--
-- Ahora se mete un paso en el medio: terminado el conteo, el despachador llena el
-- manifiesto (vehículo, conductor, ruta, peso) y recién al marcar CAMIÓN CARGADO
-- el despacho pasa a `Recolectado`.
--
--   Finalizar recolección → [MANIFIESTO] → Camión cargado → Recolectado
--                                                            ├─ correos
--                                                            ├─ auto-clasificación llano
--                                                            ├─ SIESA
--                                                            └─ arranca el reloj del auditor
--
-- No se movió el disparo de SIESA: se movió cuándo el despacho llega a
-- `Recolectado`. Todo lo que colgaba de ese estado sigue colgando de ahí, pero
-- ahora ocurre cuando la mercancía realmente se fue. El reloj del auditor
-- (`disponible_at`, migración 013) también arranca en el momento correcto.
--
-- NOTA SOBRE EL DOCUMENTO: esto NO es el manifiesto electrónico del RNDC. Aquel
-- lo emite la empresa transportadora contra el Ministerio de Transporte y trae
-- número de autorización. Este es el registro interno de quién se llevó la carga,
-- con los mismos campos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PARTE 1 — Maestros de vehículos y conductores
--
-- POR QUÉ MAESTROS Y NO CAMPOS LIBRES
-- El despachador llena esto en una tablet, en la bodega, con el camión esperando.
-- Escribir a mano la cédula, la licencia, la dirección y el teléfono del conductor
-- en CADA traslado garantiza errores de tipeo — y un manifiesto con la cédula mal
-- no sirve para lo único que tiene que servir: saber quién se llevó la carga.
-- Con el maestro, elige y se autocompleta.
--
-- `activo` en vez de borrar: un conductor que ya no trabaja acá sigue apareciendo
-- en los manifiestos viejos, así que su fila no se puede eliminar sin romper el
-- historial. Se desactiva y deja de ofrecerse en el selector.
-- ---------------------------------------------------------------------------
-- Los campos salen del maestro real de Merkahorro (INFORMACION MANIFIESTO.xlsx),
-- NO del manifiesto de la imagen: aquel es de una transportadora tercera con
-- tractomulas y trae configuración "2S2", peso vacío, poseedor y empresa. Acá la
-- flota es propia y son camiones rígidos, así que esos campos no existen — y una
-- columna que nadie llena es una columna que confunde.
CREATE TABLE IF NOT EXISTS traslados_vehiculos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placa        varchar(10)  NOT NULL,
  marca        varchar(40),                -- Chevrolet, Foton
  clase        varchar(40),                -- Camión, Camioneta
  tipo         varchar(40),                -- NQR, FRR, NHR
  color        varchar(40),
  carroceria   varchar(40),                -- Estacas, Furgón
  activo       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- La placa identifica al vehículo. Único solo entre los ACTIVOS: si un camión se
-- da de baja y años después vuelve con la misma placa, el índice parcial no
-- bloquea el alta nueva y el histórico queda intacto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehiculos_placa_activa
  ON traslados_vehiculos (upper(placa)) WHERE activo = true;

CREATE TABLE IF NOT EXISTS traslados_conductores (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento    varchar(30)  NOT NULL,
  nombre       varchar(120) NOT NULL,
  direccion    text,
  telefono     varchar(60),
  licencia     varchar(40),
  ciudad       varchar(80),
  activo       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conductores_documento_activo
  ON traslados_conductores (documento) WHERE activo = true;

-- Quién despacha. Es el equivalente al "titular del manifiesto" del documento
-- oficial. Va en su propio maestro y no se deriva de la sesión porque el login
-- identifica por correo y el manifiesto necesita cédula y teléfono, que la sesión
-- no tiene. Si algún día se les carga el correo acá, se puede preseleccionar solo.
CREATE TABLE IF NOT EXISTS traslados_despachadores (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento    varchar(30)  NOT NULL,
  nombre       varchar(120) NOT NULL,
  telefono     varchar(60),
  activo       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_despachadores_documento_activo
  ON traslados_despachadores (documento) WHERE activo = true;

-- ---------------------------------------------------------------------------
-- PARTE 2 — El manifiesto
--
-- POR QUÉ SE COPIAN LOS DATOS Y NO SOLO SE REFERENCIAN
-- Las columnas `*_id` apuntan al maestro, pero los datos del conductor y del
-- vehículo se COPIAN acá al momento de cargar. Si el mes que viene ese conductor
-- cambia de teléfono o de licencia, el manifiesto de hoy tiene que seguir
-- diciendo lo que era cierto hoy — es un documento, no una vista.
--
-- Es el mismo criterio con el que `traslados_items` guarda el snapshot de
-- inventario que vio el admin: sin la copia, mañana nadie puede reconstruir el
-- documento tal como se firmó.
--
-- Y habilita el caso "otro": un camión alquilado que no está en el maestro se
-- carga a mano, con `vehiculo_id`/`conductor_id` en NULL y los datos igual
-- completos. El manifiesto no pierde nada.
--
-- UN MANIFIESTO POR DESPACHO — y el índice único NO es solo la regla de negocio:
-- es el candado contra el doble clic en "Camión cargado". Sin él, dos envíos
-- simultáneos crearían dos manifiestos y dispararían SIESA dos veces. Acá lo
-- decide la base, no el front.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traslados_manifiestos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  despacho_id           uuid NOT NULL REFERENCES traslados_despachos(id) ON DELETE CASCADE,

  -- Referencias al maestro (NULL cuando se cargó como "otro")
  vehiculo_id           uuid REFERENCES traslados_vehiculos(id),
  conductor_id          uuid REFERENCES traslados_conductores(id),
  despachador_ref_id    uuid REFERENCES traslados_despachadores(id),

  -- Copia del vehículo
  placa                 varchar(10)  NOT NULL,
  marca                 varchar(40),
  clase                 varchar(40),
  tipo                  varchar(40),
  color                 varchar(40),
  carroceria            varchar(40),

  -- Copia del conductor
  conductor_nombre      varchar(120) NOT NULL,
  conductor_documento   varchar(30)  NOT NULL,
  conductor_direccion   text,
  conductor_telefono    varchar(60),
  conductor_licencia    varchar(40),
  conductor_ciudad      varchar(80),

  -- Copia del despachador (el "titular" del manifiesto)
  despachador_nombre    varchar(120),
  despachador_documento varchar(30),
  despachador_telefono  varchar(60),

  -- Viaje. `origen_viaje`/`destino_viaje` se prellenan con el nombre de la sede
  -- pero quedan editables: la sede es una bodega, el viaje es un lugar.
  origen_viaje          varchar(120),
  destino_viaje         varchar(120),
  ciudad                varchar(80),
  municipio             varchar(80),

  peso_kg               numeric(12,2) NOT NULL,
  observaciones         text,

  despachador_id        varchar(120),   -- quién cargó el manifiesto
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manifiesto_despacho_unico
  ON traslados_manifiestos (despacho_id);

CREATE INDEX IF NOT EXISTS idx_manifiesto_placa ON traslados_manifiestos (placa);
CREATE INDEX IF NOT EXISTS idx_manifiesto_conductor ON traslados_manifiestos (conductor_documento);
