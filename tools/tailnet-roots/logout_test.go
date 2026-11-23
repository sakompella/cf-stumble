package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"tailscale.com/control/controlclient"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/tsd"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
	"tailscale.com/types/logid"
	"tailscale.com/types/persist"
	"tailscale.com/wgengine"
)

func loggedInBackend(t *testing.T) *ipnlocal.LocalBackend {
	t.Helper()

	prefs := ipn.NewPrefs()
	prefs.WantRunning = true
	prefs.Persist = &persist.Persist{PrivateNodeKey: key.NewNode()}

	profile := &ipn.LoginProfile{ID: "1a2b", Key: "profile-1a2b"}

	profiles, err := json.Marshal(map[ipn.ProfileID]*ipn.LoginProfile{profile.ID: profile})
	if err != nil {
		t.Fatal(err)
	}

	store := new(mem.Store)

	for k, v := range map[ipn.StateKey][]byte{
		ipn.KnownProfilesStateKey:  profiles,
		ipn.CurrentProfileStateKey: []byte(profile.Key),
		profile.Key:                prefs.ToBytes(),
	} {
		if err := store.WriteState(k, v); err != nil {
			t.Fatal(err)
		}
	}

	sys := tsd.NewSystem()
	sys.Set(store)

	engine, err := wgengine.NewFakeUserspaceEngine(
		logger.Discard,
		sys.Set,
		sys.HealthTracker.Get(),
		sys.UserMetricsRegistry(),
		sys.Bus.Get(),
		sys.ControlKnobs(),
	)
	if err != nil {
		t.Fatal(err)
	}

	sys.Set(engine)

	backend, err := ipnlocal.NewLocalBackend(logger.Discard, logid.PublicID{}, sys, controlclient.LoginDefault)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(backend.Shutdown)

	return backend
}

func TestLogoutOfALoggedInNodeDoesNotPanic(t *testing.T) {
	backend := loggedInBackend(t)

	if backend.Prefs().LoggedOut() {
		t.Fatal("the seeded node starts logged out")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	t.Logf("logout: %v", (&node{lb: backend}).logout(ctx))

	if !backend.Prefs().LoggedOut() {
		t.Fatal("logout did not mark the node logged out")
	}
}
